const server = require("./server.js");
import type { Server } from "node:http";
import { env, tier } from "../core/cfg";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { mcp } from "../ai/mcp";
import { routes } from "./routes";
import {
    authenticate_api_request,
    log_authenticated_request,
} from "./middleware/auth";
import { start_reflection, stop_reflection } from "../memory/reflect";
import {
    start_user_summary_reflection,
    stop_user_summary_reflection,
} from "../memory/user_summary";
import { sendTelemetry } from "../core/telemetry";
import { req_tracker_mw } from "./routes/dashboard";
import { runEmbeddingStartupCanary } from "../memory/embed";
import { track_active_work } from "../core/active_work";
import {
    create_checkpoint_controller,
    parse_sqlite_checkpoint_config,
    type CheckpointController,
} from "../core/sqlite_checkpoint";
import {
    create_http_drain_state,
    create_shutdown_controller,
    type ShutdownController,
    type ShutdownOutcome,
} from "./shutdown";
import { close_database } from "../core/db";

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `;

const app = server({ max_payload_size: env.max_payload_size });
const http_drain = create_http_drain_state();
app.use(http_drain.middleware);

console.log(ASC);
console.log(`[CONFIG] Vector Dimension: ${env.vec_dim}`);
console.log(`[CONFIG] Cache Segments: ${env.cache_segments}`);
console.log(`[CONFIG] Max Active Queries: ${env.max_active}`);

// Warn about configuration mismatch that causes embedding incompatibility
if (env.emb_kind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    console.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
            `         OM_EMBEDDINGS=${env.emb_kind} but OM_TIER=${tier}\n` +
            `         Storage will use ${env.emb_kind} embeddings, but queries will use synthetic embeddings.\n` +
            `         This causes semantic search to fail. Set OM_TIER=deep to fix.`,
    );
}

app.use(req_tracker_mw());

app.use((req: any, res: any, next: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,x-api-key",
    );
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    next();
});

app.use(authenticate_api_request);

if (process.env.OM_LOG_AUTH === "true") {
    app.use(log_authenticated_request);
}

routes(app);

mcp(app);
if (env.mode === "langgraph") {
    console.log("[MODE] LangGraph integration enabled");
}

type SchedulerKind = "startup-decay" | "decay" | "prune";

const scheduler_jobs: Partial<Record<SchedulerKind, Promise<unknown>>> = {};
let decay_timer: NodeJS.Timeout | null = null;
let prune_timer: NodeJS.Timeout | null = null;
let shutdown_controller: ShutdownController | null = null;
let startup_checkpoint: CheckpointController | null = null;

const run_scheduler_job = <T>(
    kind: SchedulerKind,
    operation: () => Promise<T>,
): Promise<T> | null => {
    if (scheduler_jobs[kind]) {
        console.error(`[${kind.toUpperCase()}] skipped overlapping interval`);
        return null;
    }
    const observed = track_active_work(kind, operation());
    scheduler_jobs[kind] = observed;
    void observed
        .catch((error) => {
            console.error(`[${kind.toUpperCase()}] failed`, error);
        })
        .finally(() => {
            if (scheduler_jobs[kind] === observed) {
                delete scheduler_jobs[kind];
            }
        });
    return observed;
};

const clear_schedulers = (): void => {
    if (decay_timer) {
        clearInterval(decay_timer);
        decay_timer = null;
    }
    if (prune_timer) {
        clearInterval(prune_timer);
        prune_timer = null;
    }
};

const stop_schedulers = async (): Promise<void> => {
    await Promise.allSettled([
        stop_reflection(),
        stop_user_summary_reflection(),
        ...Object.values(scheduler_jobs).map((job) =>
            Promise.resolve(job).then(() => undefined),
        ),
    ]);
};

const apply_shutdown_outcome = (outcome: ShutdownOutcome): void => {
    const current_exit_code =
        typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = Math.max(current_exit_code, outcome.exit_code);
    console.log(`[SHUTDOWN] ${JSON.stringify(outcome)}`);
};

const request_shutdown = (reason: string, signal?: string): Promise<void> => {
    if (!shutdown_controller) {
        process.exitCode = 1;
        clear_schedulers();
        return stop_schedulers()
            .then(() => close_database())
            .then(() => {
                startup_checkpoint?.release();
                startup_checkpoint = null;
            })
            .catch((error) => {
                console.error(
                    "[SHUTDOWN] startup cleanup failed before listen",
                    error,
                );
            });
    }
    const pending = signal
        ? shutdown_controller.handle_signal(signal)
        : shutdown_controller.shutdown(reason);
    return pending.then(apply_shutdown_outcome);
};

const start = async () => {
    const readiness = await runEmbeddingStartupCanary();
    console.log(
        `[EMBEDDING] Ready: provider=${readiness.provider} model=${readiness.model} dimension=${readiness.dimension}`,
    );

    const checkpoint_config = parse_sqlite_checkpoint_config();
    const checkpoint = create_checkpoint_controller(checkpoint_config);
    startup_checkpoint = checkpoint;

    const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
    console.log(
        `[DECAY] Interval: ${env.decay_interval_minutes} minutes (${decayIntervalMs / 1000}s)`,
    );

    decay_timer = setInterval(() => {
        const job = run_scheduler_job("decay", async () => {
            console.log("[DECAY] Running HSG decay process...");
            const result = await run_decay_process();
            console.log(
                `[DECAY] Completed: ${result.decayed}/${result.processed} memories updated`,
            );
            return result;
        });
        void job;
    }, decayIntervalMs);
    prune_timer = setInterval(
        () => {
            const job = run_scheduler_job("prune", async () => {
                console.log("[PRUNE] Pruning weak waypoints...");
                const pruned = await prune_weak_waypoints();
                console.log(`[PRUNE] Completed: ${pruned} waypoints removed`);
                return pruned;
            });
            void job;
        },
        7 * 24 * 60 * 60 * 1000,
    );
    if (env.decay_on_startup) {
        const startup_decay = run_scheduler_job(
            "startup-decay",
            run_decay_process,
        );
        void startup_decay?.then((result: any) => {
            console.log(
                `[INIT] Initial decay: ${result.decayed}/${result.processed} memories updated`,
            );
        });
    } else {
        console.log(
            "[INIT] Startup decay disabled by OM_DECAY_ON_STARTUP=false",
        );
    }

    start_reflection();
    start_user_summary_reflection();

    console.log(`[SERVER] Starting on port ${env.port}`);
    const http_server: Server = app.listen(env.port, () => {
        console.log(`[SERVER] Running on http://localhost:${env.port}`);
        void track_active_work(
            "telemetry",
            sendTelemetry().catch(() => undefined),
        );
    });
    shutdown_controller = create_shutdown_controller({
        server: http_server,
        http: http_drain,
        checkpoint,
        clear_schedulers,
        stop_schedulers,
    });
    startup_checkpoint = null;
    checkpoint.start();

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => {
            void request_shutdown(`signal:${signal}`, signal);
        });
    }
    process.on("uncaughtException", (error) => {
        shutdown_controller?.record_fatal(error);
        void request_shutdown("fatal:uncaughtException");
    });
    process.on("unhandledRejection", (error) => {
        shutdown_controller?.record_fatal(error);
        void request_shutdown("fatal:unhandledRejection");
    });
};

start().catch((error) => {
    console.error("[STARTUP] failed:", error);
    process.exitCode = 1;
    void request_shutdown("startup-failure");
});
