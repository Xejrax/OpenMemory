import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    database_backend,
    database_path,
    run_passive_checkpoint,
    run_truncate_checkpoint,
} from "./db";

const LOCAL_FILESYSTEMS = new Set([
    "btrfs",
    "ext2",
    "ext3",
    "ext4",
    "xfs",
    "tmpfs",
]);

export type SqliteCheckpointConfig = {
    enabled: boolean;
    process_role: string;
    owner_role: string;
    deployment_scope: string;
    interval_ms: number;
    lock_path: string;
    lock_path_overridden: boolean;
    shutdown_timeout_ms: number;
    owner_grace_ms: number;
    owner_retry_ms: number;
};

export type CheckpointLeaseBody = {
    schema: "openmemory-checkpoint-lease/v1";
    database_path: string;
    hostname: string;
    pid: number;
    boot_id: string;
    process_start_ticks: string;
    release_token: string;
    created_at: string;
};

export type CheckpointLease = {
    path: string;
    body: CheckpointLeaseBody;
    release: () => void;
};

export type CheckpointMetrics = {
    attempts: number;
    completions: number;
    busy_results: number;
    errors: number;
    skipped_in_flight: number;
    skipped_transaction_busy: number;
    frames_in_wal: number;
    frames_checkpointed: number;
    duration_ms: number;
    last_timestamp: string | null;
};

export type CheckpointController = {
    readonly enabled: boolean;
    readonly is_owner: boolean;
    readonly config: SqliteCheckpointConfig;
    readonly metrics: CheckpointMetrics;
    start: () => void;
    stop: (deadline_at?: number) => Promise<void>;
    shutdown_checkpoint: (deadline_at: number) => Promise<void>;
    release: () => void;
};

export type CheckpointDependencies = {
    acquire_lease: typeof acquire_checkpoint_lease;
    passive_checkpoint: typeof run_passive_checkpoint;
    truncate_checkpoint: typeof run_truncate_checkpoint;
    sleep: (milliseconds: number) => Promise<void>;
};

const parse_bool = (value: string | undefined): boolean =>
    (value || "false").toLowerCase() === "true";

const parse_bounded_int = (
    name: string,
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number => {
    const raw = value === undefined || value === "" ? String(fallback) : value;
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${name} must be an integer`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    }
    return parsed;
};

export const parse_sqlite_checkpoint_config = (
    source: NodeJS.ProcessEnv = process.env,
    resolved_db_path: string = database_path,
): SqliteCheckpointConfig => {
    const enabled = parse_bool(source.OM_SQLITE_CHECKPOINTS_ENABLED);
    if (!enabled) {
        return {
            enabled: false,
            process_role: "",
            owner_role: "",
            deployment_scope: "",
            interval_ms: 60000,
            lock_path: `${path.resolve(resolved_db_path)}.checkpoint-owner.lock`,
            lock_path_overridden: false,
            shutdown_timeout_ms: 15000,
            owner_grace_ms: 250,
            owner_retry_ms: 100,
        };
    }

    if (database_backend !== "sqlite") {
        return {
            enabled: true,
            process_role: source.OM_PROCESS_ROLE || "",
            owner_role: source.OM_SQLITE_CHECKPOINT_OWNER_ROLE || "",
            deployment_scope:
                source.OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE || "",
            interval_ms: 60000,
            lock_path: "",
            lock_path_overridden: false,
            shutdown_timeout_ms: 15000,
            owner_grace_ms: 250,
            owner_retry_ms: 100,
        };
    }

    const process_role = source.OM_PROCESS_ROLE || "";
    const owner_role = source.OM_SQLITE_CHECKPOINT_OWNER_ROLE || "";
    const deployment_scope = source.OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE || "";
    if (!process_role) throw new Error("OM_PROCESS_ROLE is required");
    if (!owner_role)
        throw new Error("OM_SQLITE_CHECKPOINT_OWNER_ROLE is required");
    if (deployment_scope !== "single-host") {
        throw new Error(
            "OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE must be single-host",
        );
    }

    const db = path.resolve(resolved_db_path);
    const lock_path = path.resolve(
        source.OM_SQLITE_CHECKPOINT_LOCK_PATH || `${db}.checkpoint-owner.lock`,
    );
    return {
        enabled,
        process_role,
        owner_role,
        deployment_scope,
        interval_ms: parse_bounded_int(
            "OM_SQLITE_CHECKPOINT_INTERVAL_MS",
            source.OM_SQLITE_CHECKPOINT_INTERVAL_MS,
            60000,
            1000,
            86400000,
        ),
        lock_path,
        lock_path_overridden:
            source.OM_SQLITE_CHECKPOINT_LOCK_PATH !== undefined &&
            source.OM_SQLITE_CHECKPOINT_LOCK_PATH !== "",
        shutdown_timeout_ms: parse_bounded_int(
            "OM_SQLITE_SHUTDOWN_TIMEOUT_MS",
            source.OM_SQLITE_SHUTDOWN_TIMEOUT_MS,
            15000,
            1000,
            60000,
        ),
        owner_grace_ms: parse_bounded_int(
            "OM_SQLITE_OWNER_GRACE_MS",
            source.OM_SQLITE_OWNER_GRACE_MS,
            250,
            0,
            5000,
        ),
        owner_retry_ms: parse_bounded_int(
            "OM_SQLITE_OWNER_RETRY_MS",
            source.OM_SQLITE_OWNER_RETRY_MS,
            100,
            10,
            1000,
        ),
    };
};

const read_boot_id = (): string =>
    fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

const read_process_start_ticks = (pid: number): string => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error(`malformed /proc/${pid}/stat`);
    const fields_from_three = stat.slice(close + 2).split(/\s+/);
    const start_ticks = fields_from_three[19];
    if (!start_ticks || !/^\d+$/.test(start_ticks)) {
        throw new Error(`missing start ticks for pid ${pid}`);
    }
    return start_ticks;
};

const current_identity = (resolved_db_path: string): CheckpointLeaseBody => ({
    schema: "openmemory-checkpoint-lease/v1",
    database_path: resolved_db_path,
    hostname: os.hostname(),
    pid: process.pid,
    boot_id: read_boot_id(),
    process_start_ticks: read_process_start_ticks(process.pid),
    release_token: crypto.randomBytes(24).toString("hex"),
    created_at: new Date().toISOString(),
});

const parse_mountinfo = (
    target: string,
    text: string = fs.readFileSync("/proc/self/mountinfo", "utf8"),
): { mount_point: string; filesystem: string } => {
    const resolved = path.resolve(target);
    let best: { mount_point: string; filesystem: string } | null = null;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split(" ");
        const separator = parts.indexOf("-");
        if (separator < 0 || parts.length <= separator + 1) continue;
        const mount_point = parts[4]
            .replace(/\\040/g, " ")
            .replace(/\\011/g, "\t")
            .replace(/\\134/g, "\\");
        const filesystem = parts[separator + 1];
        if (
            (resolved === mount_point ||
                resolved.startsWith(`${mount_point.replace(/\/$/, "")}/`)) &&
            (!best || mount_point.length > best.mount_point.length)
        ) {
            best = { mount_point, filesystem };
        }
    }
    if (!best) throw new Error(`no mountinfo entry for ${resolved}`);
    return best;
};

const assert_local_filesystem = (target: string, mountinfo?: string): void => {
    const { filesystem } = parse_mountinfo(target, mountinfo);
    if (!LOCAL_FILESYSTEMS.has(filesystem)) {
        throw new Error(
            `unsupported checkpoint lease filesystem: ${filesystem}`,
        );
    }
};

const assert_not_symlink = (target: string, label: string): void => {
    try {
        if (fs.lstatSync(target).isSymbolicLink()) {
            throw new Error(`${label} must not be a symlink`);
        }
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }
};

const write_exclusive_json = (target: string, value: unknown): void => {
    const fd = fs.openSync(target, "wx", 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
};

const run_lease_primitive_probe = (directory: string): void => {
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const first = path.join(directory, `.om-checkpoint-probe-${nonce}`);
    const second = `${first}.renamed`;
    const token = crypto.randomBytes(24).toString("hex");
    try {
        const fd = fs.openSync(first, "wx", 0o600);
        try {
            fs.writeFileSync(fd, token, "utf8");
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        let saw_eexist = false;
        try {
            const duplicate = fs.openSync(first, "wx", 0o600);
            fs.closeSync(duplicate);
        } catch (error: any) {
            saw_eexist = error?.code === "EEXIST";
        }
        if (!saw_eexist) {
            throw new Error("lease probe did not observe EEXIST");
        }
        fs.renameSync(first, second);
        if (fs.readFileSync(second, "utf8") !== token) {
            throw new Error("lease probe token mismatch after rename");
        }
    } finally {
        for (const candidate of [first, second]) {
            try {
                if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
            } catch {
                // Startup still fails on the original probe error. A leftover
                // uniquely named self-created probe is safe forensic evidence.
            }
        }
    }
};

const read_lease = (target: string): CheckpointLeaseBody => {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (
        parsed?.schema !== "openmemory-checkpoint-lease/v1" ||
        typeof parsed.release_token !== "string"
    ) {
        throw new Error("malformed checkpoint lease");
    }
    return parsed as CheckpointLeaseBody;
};

const lease_is_live = (
    body: CheckpointLeaseBody,
    local: CheckpointLeaseBody,
): boolean => {
    if (body.hostname !== local.hostname) {
        throw new Error(
            `foreign-host checkpoint lease: ${body.hostname || "unknown"}`,
        );
    }
    if (body.boot_id !== local.boot_id) return false;
    try {
        return read_process_start_ticks(body.pid) === body.process_start_ticks;
    } catch (error: any) {
        if (error?.code === "ENOENT") return false;
        throw error;
    }
};

const validate_lease_paths = (
    db_path: string,
    lock_path: string,
    lock_path_overridden: boolean,
): void => {
    const db = path.resolve(db_path);
    const lock = path.resolve(lock_path);
    const db_parent = fs.realpathSync(path.dirname(db));
    const lock_parent = fs.realpathSync(path.dirname(lock));
    assert_not_symlink(db, "database path");
    assert_not_symlink(lock, "checkpoint lease path");
    const db_stat = fs.statSync(db_parent);
    const lock_stat = fs.statSync(lock_parent);
    if (db_stat.dev !== lock_stat.dev) {
        throw new Error("checkpoint lease path crosses filesystem devices");
    }
    if (!lock_path_overridden && db_parent !== lock_parent) {
        throw new Error("default checkpoint lease must be database-adjacent");
    }
    assert_local_filesystem(db_parent);
    run_lease_primitive_probe(lock_parent);
};

export const acquire_checkpoint_lease = (
    config: SqliteCheckpointConfig,
    resolved_db_path: string = database_path,
): CheckpointLease | null => {
    if (
        !config.enabled ||
        database_backend !== "sqlite" ||
        config.process_role !== config.owner_role
    ) {
        return null;
    }

    const db = path.resolve(resolved_db_path);
    validate_lease_paths(db, config.lock_path, config.lock_path_overridden);
    const local = current_identity(db);
    fs.mkdirSync(path.dirname(config.lock_path), { recursive: true });

    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            write_exclusive_json(config.lock_path, local);
            const release = (): void => {
                const current = read_lease(config.lock_path);
                if (
                    current.release_token !== local.release_token ||
                    current.pid !== local.pid ||
                    current.process_start_ticks !== local.process_start_ticks
                ) {
                    throw new Error("checkpoint lease identity changed");
                }
                fs.unlinkSync(config.lock_path);
            };
            return { path: config.lock_path, body: local, release };
        } catch (error: any) {
            if (error?.code !== "EEXIST") throw error;
        }

        const existing = read_lease(config.lock_path);
        if (lease_is_live(existing, local)) {
            throw new Error(
                `duplicate live checkpoint owner pid=${existing.pid}`,
            );
        }

        const quarantine = `${config.lock_path}.stale-${process.pid}-${crypto
            .randomBytes(6)
            .toString("hex")}`;
        try {
            fs.renameSync(config.lock_path, quarantine);
        } catch (error: any) {
            if (error?.code === "ENOENT") continue;
            throw error;
        }
        try {
            const captured = read_lease(quarantine);
            if (captured.release_token !== existing.release_token) {
                throw new Error("stale lease changed during quarantine");
            }
            fs.unlinkSync(quarantine);
        } catch (error) {
            console.error(
                "[CHECKPOINT] stale quarantine cleanup failed",
                error,
            );
        }
    }
    throw new Error("checkpoint lease acquisition did not converge");
};

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
    });

const await_before_deadline = async <T>(
    promise: Promise<T>,
    deadline_at: number,
    label: string,
): Promise<T> => {
    const remaining = deadline_at - Date.now();
    if (remaining <= 0) throw new Error(`${label}_TIMEOUT`);
    return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`${label}_TIMEOUT`)),
                remaining,
            );
            timer.unref?.();
        }),
    ]);
};

export const create_checkpoint_controller = (
    config: SqliteCheckpointConfig,
    overrides: Partial<CheckpointDependencies> = {},
): CheckpointController => {
    const dependencies: CheckpointDependencies = {
        acquire_lease: acquire_checkpoint_lease,
        passive_checkpoint: run_passive_checkpoint,
        truncate_checkpoint: run_truncate_checkpoint,
        sleep,
        ...overrides,
    };
    const is_owner =
        config.enabled &&
        database_backend === "sqlite" &&
        config.process_role === config.owner_role;
    const lease = is_owner ? dependencies.acquire_lease(config) : null;
    const metrics: CheckpointMetrics = {
        attempts: 0,
        completions: 0,
        busy_results: 0,
        errors: 0,
        skipped_in_flight: 0,
        skipped_transaction_busy: 0,
        frames_in_wal: 0,
        frames_checkpointed: 0,
        duration_ms: 0,
        last_timestamp: null,
    };
    let timer: NodeJS.Timeout | null = null;
    let passive_in_flight: Promise<void> | null = null;
    let released = false;

    const periodic = (): void => {
        if (!is_owner) return;
        if (passive_in_flight) {
            metrics.skipped_in_flight++;
            return;
        }
        passive_in_flight = (async () => {
            const started = performance.now();
            metrics.attempts++;
            try {
                const result = await dependencies.passive_checkpoint();
                if (result.skipped_transaction_busy) {
                    metrics.skipped_transaction_busy++;
                    return;
                }
                metrics.completions++;
                metrics.busy_results += result.busy === 0 ? 0 : 1;
                metrics.frames_in_wal = result.frames_in_wal;
                metrics.frames_checkpointed = result.frames_checkpointed;
            } catch (error) {
                metrics.errors++;
                console.error("[CHECKPOINT] periodic PASSIVE failed", error);
            } finally {
                metrics.duration_ms = Number(
                    (performance.now() - started).toFixed(3),
                );
                metrics.last_timestamp = new Date().toISOString();
                passive_in_flight = null;
            }
        })();
    };

    return {
        enabled: config.enabled,
        is_owner,
        config,
        metrics,
        start: () => {
            if (!is_owner || timer) return;
            timer = setInterval(periodic, config.interval_ms);
            timer.unref?.();
        },
        stop: async (deadline_at = Number.POSITIVE_INFINITY) => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (passive_in_flight) {
                await await_before_deadline(
                    passive_in_flight,
                    deadline_at,
                    "PASSIVE_CHECKPOINT_JOIN",
                );
            }
        },
        shutdown_checkpoint: async (deadline_at: number) => {
            if (!is_owner) return;
            if (config.owner_grace_ms > 0) {
                await await_before_deadline(
                    dependencies.sleep(config.owner_grace_ms),
                    deadline_at,
                    "OWNER_GRACE",
                );
            }
            for (;;) {
                const result = await await_before_deadline(
                    dependencies.truncate_checkpoint(),
                    deadline_at,
                    "TRUNCATE_CHECKPOINT",
                );
                if (result.busy === 0) return;
                if (Date.now() + config.owner_retry_ms >= deadline_at) {
                    throw new Error("TRUNCATE_CHECKPOINT_TIMEOUT");
                }
                await dependencies.sleep(config.owner_retry_ms);
            }
        },
        release: () => {
            if (!lease || released) return;
            lease.release();
            released = true;
        },
    };
};

export const sqlite_checkpoint_test_helpers = {
    assert_local_filesystem,
    parse_mountinfo,
    read_process_start_ticks,
    run_lease_primitive_probe,
};
