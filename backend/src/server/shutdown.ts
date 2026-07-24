import type { Server } from "node:http";
import {
    active_work_errors,
    active_work_snapshot,
    freeze_active_work,
    join_active_work,
} from "../core/active_work";
import {
    begin_db_quiesce,
    close_database,
    database_lifecycle_snapshot,
    wait_for_db_quiescence,
} from "../core/db";
import type { CheckpointController } from "../core/sqlite_checkpoint";

export type HttpDrainState = {
    middleware: (req: any, res: any, next: any) => void;
    begin: () => void;
    wait_for_zero: (deadline_at: number) => Promise<void>;
    snapshot: () => {
        draining: boolean;
        active_requests: number;
        forced_close: boolean;
    };
    mark_forced_close: () => void;
};

export type ShutdownOutcome = {
    exit_code: 0 | 1 | 2;
    reason: string;
    signal: string | null;
    started_at: string;
    finished_at: string;
    checkpoint_owner: boolean;
    truncate_attempted: boolean;
    http_forced_close: boolean;
    errors: string[];
    active_work: ReturnType<typeof active_work_snapshot>;
    database: ReturnType<typeof database_lifecycle_snapshot>;
};

export type ShutdownController = {
    handle_signal: (signal: string) => Promise<ShutdownOutcome>;
    shutdown: (reason?: string) => Promise<ShutdownOutcome>;
    record_fatal: (error: unknown) => void;
    current: () => Promise<ShutdownOutcome> | null;
};

const timeout_error = (label: string): Error => {
    const error = new Error(`${label}_TIMEOUT`);
    (error as any).code = "SHUTDOWN_TIMEOUT";
    return error;
};

const before_deadline = async <T>(
    promise: Promise<T>,
    deadline_at: number,
    label: string,
): Promise<T> => {
    const remaining = deadline_at - Date.now();
    if (remaining <= 0) throw timeout_error(label);
    return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            const timer = setTimeout(
                () => reject(timeout_error(label)),
                remaining,
            );
            timer.unref?.();
        }),
    ]);
};

export const create_http_drain_state = (): HttpDrainState => {
    let draining = false;
    let active_requests = 0;
    let forced_close = false;
    const zero_waiters = new Set<() => void>();

    const decrement = (): void => {
        active_requests = Math.max(0, active_requests - 1);
        if (active_requests === 0) {
            for (const resolve of zero_waiters) resolve();
            zero_waiters.clear();
        }
    };

    return {
        middleware: (_req, res, next) => {
            if (draining) {
                res.setHeader("Connection", "close");
                res.status(503).end("Service Unavailable: shutting down");
                return;
            }
            active_requests++;
            let completed = false;
            const finish = () => {
                if (completed) return;
                completed = true;
                decrement();
            };
            res.once("finish", finish);
            res.once("close", finish);
            next();
        },
        begin: () => {
            draining = true;
        },
        wait_for_zero: async (deadline_at) => {
            if (active_requests === 0) return;
            await before_deadline(
                new Promise<void>((resolve) => zero_waiters.add(resolve)),
                deadline_at,
                "HTTP_ACTIVE_REQUESTS",
            );
        },
        snapshot: () => ({ draining, active_requests, forced_close }),
        mark_forced_close: () => {
            forced_close = true;
        },
    };
};

const close_http_server = async (
    server: Server,
    http: HttpDrainState,
    deadline_at: number,
): Promise<void> => {
    http.begin();
    server.closeIdleConnections?.();
    const close = new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
            if (error && (error as any).code !== "ERR_SERVER_NOT_RUNNING") {
                reject(error);
            } else {
                resolve();
            }
        });
    });
    const drained = http.wait_for_zero(deadline_at).then(() => {
        // A connection that was active when shutdown began can become an idle
        // keep-alive after the first closeIdleConnections() sweep.
        server.closeIdleConnections?.();
    });
    try {
        await before_deadline(
            Promise.all([close, drained]).then(() => undefined),
            deadline_at,
            "HTTP_DRAIN",
        );
    } catch (error) {
        http.mark_forced_close();
        server.closeAllConnections?.();
        throw error;
    }
};

const normalize_error = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

export const create_shutdown_controller = (options: {
    server: Server;
    http: HttpDrainState;
    checkpoint: CheckpointController;
    clear_schedulers: () => void;
    stop_schedulers: () => Promise<void>;
}): ShutdownController => {
    const { server, http, checkpoint, clear_schedulers, stop_schedulers } =
        options;
    let shared: Promise<ShutdownOutcome> | null = null;
    let requested_signal: string | null = null;
    const fatal_errors: Error[] = [];

    const record_fatal = (error: unknown): void => {
        const normalized = normalize_error(error);
        fatal_errors.push(normalized);
        console.error("[SHUTDOWN] fatal lifecycle error", normalized);
    };

    const execute = async (reason: string): Promise<ShutdownOutcome> => {
        const started_at = new Date().toISOString();
        const deadline_at =
            Date.now() + options.checkpoint.config.shutdown_timeout_ms;
        const errors: Error[] = [];
        let truncate_attempted = false;
        let exit_code: 0 | 1 | 2 = 0;

        try {
            clear_schedulers();
            await close_http_server(server, http, deadline_at);

            await before_deadline(
                stop_schedulers(),
                deadline_at,
                "SCHEDULER_JOIN",
            );
            freeze_active_work();
            await before_deadline(
                join_active_work(deadline_at),
                deadline_at,
                "ACTIVE_WORK_JOIN",
            );
            await checkpoint.stop(deadline_at);

            const work_errors = active_work_errors();
            if (work_errors.length > 0) {
                errors.push(
                    new Error(
                        `ACTIVE_WORK_FAILED: ${work_errors
                            .map((error) => error.message)
                            .join("; ")}`,
                    ),
                );
            }
            for (const error of fatal_errors) {
                if (!errors.includes(error)) errors.push(error);
            }

            begin_db_quiesce();
            await before_deadline(
                wait_for_db_quiescence(),
                deadline_at,
                "DATABASE_QUIESCE",
            );
            if (checkpoint.is_owner) {
                truncate_attempted = true;
                await checkpoint.shutdown_checkpoint(deadline_at);
            }
            await before_deadline(
                close_database(),
                deadline_at,
                "DATABASE_CLOSE",
            );
            checkpoint.release();
        } catch (error) {
            const normalized = normalize_error(error);
            errors.push(normalized);
            if (
                (normalized as any).code === "SHUTDOWN_TIMEOUT" ||
                normalized.message.endsWith("_TIMEOUT")
            ) {
                exit_code = 2;
            } else {
                exit_code = 1;
            }
            console.error("[SHUTDOWN] unclean shutdown", normalized);
        }

        if (fatal_errors.length > 0 && exit_code === 0) {
            exit_code = 1;
        }
        for (const error of fatal_errors) {
            if (!errors.includes(error)) errors.push(error);
        }
        if (errors.length > 0 && exit_code === 0) exit_code = 1;
        const snapshot = http.snapshot();
        if (snapshot.forced_close) exit_code = 2;

        return {
            exit_code,
            reason,
            signal: requested_signal,
            started_at,
            finished_at: new Date().toISOString(),
            checkpoint_owner: checkpoint.is_owner,
            truncate_attempted,
            http_forced_close: snapshot.forced_close,
            errors: errors.map((error) => error.message),
            active_work: active_work_snapshot(),
            database: database_lifecycle_snapshot(),
        };
    };

    const shutdown = (reason = "shutdown"): Promise<ShutdownOutcome> => {
        if (!shared) shared = execute(reason);
        return shared;
    };

    return {
        handle_signal: (signal) => {
            requested_signal ||= signal;
            return shutdown(`signal:${signal}`);
        },
        shutdown,
        record_fatal,
        current: () => shared,
    };
};
