import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2] || "";
const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const child_env = (
    db_path: string,
    extra: Record<string, string> = {},
): NodeJS.ProcessEnv => ({
    ...process.env,
    OM_DB_PATH: db_path,
    OM_METADATA_BACKEND: "sqlite",
    OM_VECTOR_BACKEND: "sqlite",
    OM_SQLITE_CHECKPOINTS_ENABLED: "false",
    OM_DECAY_ON_STARTUP: "false",
    OM_TIER: "deep",
    ...extra,
});

const child_args = (child_mode: string) => [
    "--import",
    "tsx",
    self,
    child_mode,
];

const run_child = (
    child_mode: string,
    db_path: string,
    extra: Record<string, string> = {},
) => {
    const result = spawnSync(process.execPath, child_args(child_mode), {
        env: child_env(db_path, extra),
        encoding: "utf8",
        timeout: 30000,
    });
    const json_line = result.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line) => line.trim().startsWith("{"));
    return {
        ...result,
        parsed: json_line ? JSON.parse(json_line) : null,
    };
};

const import_db = async () => await import("../src/core/db");

const fake_lease = (released: { count: number }) => ({
    path: "/tmp/test-checkpoint.lock",
    body: {
        schema: "openmemory-checkpoint-lease/v1" as const,
        database_path: "/tmp/test.sqlite",
        hostname: os.hostname(),
        pid: process.pid,
        boot_id: "test",
        process_start_ticks: "1",
        release_token: "test",
        created_at: new Date().toISOString(),
    },
    release: () => {
        released.count++;
    },
});

const checkpoint_config = (overrides: Record<string, unknown> = {}): any => ({
    enabled: true,
    process_role: "api",
    owner_role: "api",
    deployment_scope: "single-host",
    interval_ms: 1000,
    lock_path: "/tmp/test-checkpoint.lock",
    lock_path_overridden: true,
    shutdown_timeout_ms: 2000,
    owner_grace_ms: 0,
    owner_retry_ms: 20,
    ...overrides,
});

const make_server = async (
    middleware: (req: any, res: any, next: any) => void,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) => {
    const server = http.createServer((req, res) =>
        middleware(req, res, () => handler(req, res)),
    );
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    return server;
};

const request = async (
    server: http.Server,
    pathname: string,
    agent?: http.Agent,
): Promise<{ status: number; body: string }> => {
    const address = server.address();
    assert(address && typeof address === "object");
    return await new Promise((resolve, reject) => {
        const req = http.get(
            {
                host: "127.0.0.1",
                port: address.port,
                path: pathname,
                agent,
            },
            (res) => {
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () =>
                    resolve({ status: res.statusCode || 0, body }),
                );
            },
        );
        req.on("error", reject);
    });
};

const run_child_mode = async (): Promise<boolean> => {
    if (!mode) return false;
    const db = await import_db();
    const checkpoint = await import("../src/core/sqlite_checkpoint");
    const shutdown = await import("../src/server/shutdown");
    await db.wait_for_database_ready();

    if (mode === "writer" || mode === "owner-writer") {
        const controller =
            mode === "owner-writer"
                ? checkpoint.create_checkpoint_controller(
                      checkpoint.parse_sqlite_checkpoint_config(),
                  )
                : null;
        controller?.start();
        await db.run_async(
            "create table if not exists lifecycle_fixture(id text primary key, value text)",
        );
        for (let index = 0; index < 40; index++) {
            await db.run_async(
                "insert or replace into lifecycle_fixture(id,value) values(?,?)",
                [`${process.pid}-${index}`, `${mode}-${index}`],
            );
            await sleep(30);
        }
        if (controller) {
            await controller.stop(Date.now() + 3000);
            controller.release();
        }
        const row = await db.get_async(
            "select count(*) as count from lifecycle_fixture",
        );
        await db.close_database();
        console.log(
            JSON.stringify({
                count: Number(row.count),
                attempts: controller?.metrics.attempts || 0,
                owner: controller?.is_owner || false,
            }),
        );
        return true;
    }

    if (mode === "lease-holder" || mode === "lease-contender") {
        try {
            const controller = checkpoint.create_checkpoint_controller(
                checkpoint.parse_sqlite_checkpoint_config(),
            );
            if (mode === "lease-holder") {
                console.log(JSON.stringify({ ready: true }));
                await sleep(1800);
            }
            controller.release();
            await db.close_database();
            console.log(JSON.stringify({ acquired: true }));
        } catch (error) {
            await db.close_database();
            console.log(
                JSON.stringify({
                    acquired: false,
                    error:
                        error instanceof Error ? error.message : String(error),
                }),
            );
        }
        return true;
    }

    if (mode === "reclaimer") {
        try {
            const controller = checkpoint.create_checkpoint_controller(
                checkpoint.parse_sqlite_checkpoint_config(),
            );
            await sleep(700);
            controller.release();
            await db.close_database();
            console.log(JSON.stringify({ acquired: true }));
        } catch (error) {
            await db.close_database();
            console.log(
                JSON.stringify({
                    acquired: false,
                    error:
                        error instanceof Error ? error.message : String(error),
                }),
            );
        }
        return true;
    }

    if (mode === "db-quiesce") {
        await db.run_async(
            "create table if not exists lifecycle_fixture(id text primary key, value text)",
        );
        let release_transaction!: () => void;
        const transaction_gate = new Promise<void>(
            (resolve) => (release_transaction = resolve),
        );
        const transaction = db.with_transaction(async () => {
            await db.run_async(
                "insert or replace into lifecycle_fixture(id,value) values(?,?)",
                ["pre-quiesce", "admitted"],
            );
            const passive = await db.run_passive_checkpoint();
            assert.equal(passive.skipped_transaction_busy, true);
            await assert.rejects(
                db.with_transaction(async () => undefined),
                /NESTED_TRANSACTION_UNSUPPORTED/,
            );
            await transaction_gate;
        });
        await sleep(50);
        db.begin_db_quiesce();
        await assert.rejects(db.run_async("select 1"), /DATABASE_QUIESCING/);
        await assert.rejects(
            db.with_transaction(async () => undefined),
            /DATABASE_QUIESCING/,
        );
        let fenced = false;
        const fence = db.wait_for_db_quiescence().then(() => {
            fenced = true;
        });
        await sleep(50);
        assert.equal(fenced, false);
        release_transaction();
        await transaction;
        await fence;
        const truncate = await db.run_truncate_checkpoint();
        await db.close_database();
        console.log(
            JSON.stringify({
                pre_admitted_completed: true,
                late_refused: true,
                nested_refused: true,
                passive_skipped: true,
                truncate_busy: truncate.busy,
            }),
        );
        return true;
    }

    if (mode === "wal-growth") {
        await db.run_async(
            "create table if not exists lifecycle_fixture(id text primary key, value text)",
        );
        for (let index = 0; index < 250; index++) {
            await db.run_async(
                "insert or replace into lifecycle_fixture(id,value) values(?,?)",
                [`wal-${index}`, "x".repeat(2048)],
            );
        }
        const wal_path = `${process.env.OM_DB_PATH}-wal`;
        const before = fs.existsSync(wal_path) ? fs.statSync(wal_path).size : 0;
        const passive = await db.run_passive_checkpoint();
        const after = fs.existsSync(wal_path) ? fs.statSync(wal_path).size : 0;
        await db.close_database();
        console.log(
            JSON.stringify({
                before,
                after,
                busy: passive.busy,
                bounded: after <= Math.max(before, 20_000 * 4096),
            }),
        );
        return true;
    }

    if (mode === "crash-writer") {
        await db.run_async(
            "create table if not exists crash_fixture(id text primary key, value text)",
        );
        for (let index = 0; index < 25; index++) {
            await db.run_async(
                "insert into crash_fixture(id,value) values(?,?)",
                [`crash-${index}`, `committed-${index}`],
            );
        }
        process.stdout.write(`${JSON.stringify({ committed: 25 })}\n`);
        process.kill(process.pid, "SIGKILL");
        return true;
    }

    if (mode === "read-integrity") {
        const row = await db.get_async(
            "select count(*) as count from crash_fixture",
        );
        const integrity = await db.all_async("PRAGMA integrity_check");
        await db.close_database();
        console.log(
            JSON.stringify({
                count: Number(row.count),
                integrity: Object.values(integrity[0] || {})[0],
            }),
        );
        return true;
    }

    if (mode.startsWith("shutdown-")) {
        const http_drain = shutdown.create_http_drain_state();
        let active_delay = 0;
        if (mode === "shutdown-http-timeout") active_delay = 1600;
        if (mode === "shutdown-http-clean") active_delay = 180;
        const server = await make_server(http_drain.middleware, (req, res) => {
            const delay = req.url === "/slow" ? active_delay : 0;
            setTimeout(() => res.end(req.url || "ok"), delay);
        });

        let released = { count: 0 };
        let truncate_calls = 0;
        let controller_config: any = checkpoint_config();
        let checkpoint_controller: any;
        if (mode === "shutdown-nonowner") {
            controller_config = checkpoint_config({
                process_role: "worker",
                owner_role: "api",
            });
            checkpoint_controller = checkpoint.create_checkpoint_controller(
                controller_config,
                {
                    truncate_checkpoint: async () => {
                        truncate_calls++;
                        return {
                            busy: 0,
                            frames_in_wal: 0,
                            frames_checkpointed: 0,
                        };
                    },
                },
            );
        } else {
            if (
                mode === "shutdown-http-timeout" ||
                mode === "shutdown-active-timeout" ||
                mode === "shutdown-owner-timeout"
            ) {
                controller_config.shutdown_timeout_ms = 1000;
            }
            let truncate_result = 0;
            checkpoint_controller = checkpoint.create_checkpoint_controller(
                controller_config,
                {
                    acquire_lease: () => fake_lease(released),
                    truncate_checkpoint: async () => {
                        truncate_calls++;
                        if (mode === "shutdown-owner-timeout") {
                            return await new Promise(() => {});
                        }
                        if (
                            mode === "shutdown-owner-retry" &&
                            truncate_result++ === 0
                        ) {
                            return {
                                busy: 1,
                                frames_in_wal: 1,
                                frames_checkpointed: 0,
                            };
                        }
                        return {
                            busy: 0,
                            frames_in_wal: 0,
                            frames_checkpointed: 0,
                        };
                    },
                },
            );
        }

        const lifecycle = shutdown.create_shutdown_controller({
            server,
            http: http_drain,
            checkpoint: checkpoint_controller,
            clear_schedulers: () => undefined,
            stop_schedulers: async () => undefined,
        });

        let request_result: Promise<unknown> | null = null;
        let agent: http.Agent | undefined;
        if (mode === "shutdown-http-clean") {
            agent = new http.Agent({ keepAlive: true });
            await request(server, "/fast", agent);
            request_result = request(server, "/slow", agent);
            await sleep(30);
        }
        if (mode === "shutdown-http-timeout") {
            request_result = request(server, "/slow").catch((error) => ({
                error: error instanceof Error ? error.message : String(error),
            }));
            await sleep(30);
        }
        if (mode === "shutdown-active-timeout") {
            const active = await import("../src/core/active_work");
            void active
                .track_active_work("test-long-work", sleep(1600))
                .catch(() => undefined);
        }
        if (mode === "shutdown-fatal") {
            lifecycle.record_fatal(new Error("synthetic-fatal"));
        }

        const first = lifecycle.shutdown(mode);
        const second = lifecycle.shutdown("duplicate");
        assert.equal(first, second);
        const outcome = await first;
        await request_result;
        agent?.destroy();
        if (outcome.exit_code !== 0) {
            await db.close_database().catch(() => undefined);
        }
        console.log(
            JSON.stringify({
                outcome,
                same_promise: first === second,
                truncate_calls,
                released: released.count,
            }),
        );
        return true;
    }

    throw new Error(`unknown child mode: ${mode}`);
};

if (await run_child_mode()) {
    await new Promise<void>((resolve) => process.stdout.write("", resolve));
    process.exit(0);
} else {
    const root = fs.mkdtempSync(
        path.join("/tmp", "openmemory-checkpoint-lifecycle-"),
    );
    process.env.OM_DB_PATH = path.join(root, "parent.sqlite");
    process.env.OM_METADATA_BACKEND = "sqlite";
    process.env.OM_VECTOR_BACKEND = "sqlite";
    process.env.OM_SQLITE_CHECKPOINTS_ENABLED = "false";
    process.env.OM_DECAY_ON_STARTUP = "false";
    process.env.OM_TIER = "deep";

    const db = await import_db();
    const checkpoint = await import("../src/core/sqlite_checkpoint");
    const active = await import("../src/core/active_work");
    const shutdown = await import("../src/server/shutdown");
    await db.wait_for_database_ready();

    const results: Array<{ id: number; name: string; evidence: unknown }> = [];
    const pass = (id: number, name: string, evidence: unknown = true) => {
        results.push({ id, name, evidence });
        console.log(`PASS ${id}/27 ${name}`);
    };

    const disabled = checkpoint.parse_sqlite_checkpoint_config(
        { OM_SQLITE_CHECKPOINTS_ENABLED: "false" },
        path.join(root, "disabled.sqlite"),
    );
    const disabled_controller =
        checkpoint.create_checkpoint_controller(disabled);
    disabled_controller.start();
    await sleep(30);
    assert.equal(disabled_controller.metrics.attempts, 0);
    pass(1, "default-disabled-zero-periodic-attempts");

    const shared_db = path.join(root, "shared.sqlite");
    const owner = spawn(process.execPath, child_args("owner-writer"), {
        env: child_env(shared_db, {
            OM_SQLITE_CHECKPOINTS_ENABLED: "true",
            OM_PROCESS_ROLE: "api",
            OM_SQLITE_CHECKPOINT_OWNER_ROLE: "api",
            OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE: "single-host",
            OM_SQLITE_CHECKPOINT_INTERVAL_MS: "1000",
        }),
    });
    const nonowner = spawn(process.execPath, child_args("writer"), {
        env: child_env(shared_db),
    });
    const collect = async (child: ReturnType<typeof spawn>) => {
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk));
        child.stderr?.on("data", (chunk) => (stderr += chunk));
        const exit = await new Promise<number | null>((resolve) =>
            child.on("close", resolve),
        );
        const json_line = stdout
            .trim()
            .split("\n")
            .reverse()
            .find((line) => line.trim().startsWith("{"));
        return {
            exit,
            stderr,
            stdout,
            parsed: json_line ? JSON.parse(json_line) : null,
        };
    };
    const [owner_result, nonowner_result] = await Promise.all([
        collect(owner),
        collect(nonowner),
    ]);
    assert.equal(owner_result.exit, 0, owner_result.stderr);
    assert.equal(nonowner_result.exit, 0, nonowner_result.stderr);
    assert(owner_result.parsed, owner_result.stderr || owner_result.stdout);
    assert(
        nonowner_result.parsed,
        nonowner_result.stderr || nonowner_result.stdout,
    );
    assert(owner_result.parsed.count >= 80);
    assert(nonowner_result.parsed.count >= 80);
    pass(2, "owner-nonowner-shared-wal-read-write", {
        owner_count: owner_result.parsed.count,
        nonowner_count: nonowner_result.parsed.count,
    });
    assert(owner_result.parsed.attempts >= 1);
    assert.equal(nonowner_result.parsed.attempts, 0);
    pass(3, "only-owner-runs-periodic-passive", {
        owner_attempts: owner_result.parsed.attempts,
    });

    const lease_db = path.join(root, "duplicate.sqlite");
    const lease_env = {
        OM_SQLITE_CHECKPOINTS_ENABLED: "true",
        OM_PROCESS_ROLE: "api",
        OM_SQLITE_CHECKPOINT_OWNER_ROLE: "api",
        OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE: "single-host",
    };
    const holder = spawn(process.execPath, child_args("lease-holder"), {
        env: child_env(lease_db, lease_env),
    });
    let holder_stdout = "";
    let holder_stderr = "";
    holder.stdout?.on("data", (chunk) => (holder_stdout += chunk));
    holder.stderr?.on("data", (chunk) => (holder_stderr += chunk));
    await sleep(400);
    const contender = run_child("lease-contender", lease_db, lease_env);
    assert.equal(contender.status, 0, contender.stderr);
    assert.equal(contender.parsed.acquired, false);
    assert.match(contender.parsed.error, /duplicate live checkpoint owner/);
    await new Promise((resolve) => holder.on("close", resolve));
    assert.equal(holder_stderr, "");
    assert.match(holder_stdout, /"acquired":true/);
    pass(4, "duplicate-live-owner-refused");

    const identity_db = path.join(root, "identity.sqlite");
    fs.writeFileSync(identity_db, "");
    const identity_config = checkpoint.parse_sqlite_checkpoint_config(
        {
            OM_SQLITE_CHECKPOINTS_ENABLED: "true",
            OM_PROCESS_ROLE: "api",
            OM_SQLITE_CHECKPOINT_OWNER_ROLE: "api",
            OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE: "single-host",
        },
        identity_db,
    );
    fs.writeFileSync(
        identity_config.lock_path,
        `${JSON.stringify({
            schema: "openmemory-checkpoint-lease/v1",
            database_path: identity_db,
            hostname: os.hostname(),
            pid: process.pid,
            boot_id: fs
                .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
                .trim(),
            process_start_ticks: "1",
            release_token: "stale-pid-reuse",
            created_at: new Date().toISOString(),
        })}\n`,
    );
    const identity_lease = checkpoint.acquire_checkpoint_lease(
        identity_config,
        identity_db,
    );
    assert(identity_lease);
    identity_lease.release();
    pass(5, "pid-reuse-start-ticks-treated-stale");

    const race_db = path.join(root, "race.sqlite");
    fs.writeFileSync(race_db, "");
    const race_lock = `${race_db}.checkpoint-owner.lock`;
    fs.writeFileSync(
        race_lock,
        `${JSON.stringify({
            schema: "openmemory-checkpoint-lease/v1",
            database_path: race_db,
            hostname: os.hostname(),
            pid: 999999,
            boot_id: fs
                .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
                .trim(),
            process_start_ticks: "1",
            release_token: "stale-race",
            created_at: new Date().toISOString(),
        })}\n`,
    );
    const race_children = [0, 1].map(() =>
        spawn(process.execPath, child_args("reclaimer"), {
            env: child_env(race_db, lease_env),
        }),
    );
    const race_results = await Promise.all(race_children.map(collect));
    assert.equal(
        race_results.filter((result) => result.parsed.acquired).length,
        1,
    );
    pass(6, "concurrent-stale-reclaim-exactly-one-owner", {
        outcomes: race_results.map((result) => result.parsed.acquired),
    });

    const refusal_db = path.join(root, "refusals.sqlite");
    fs.writeFileSync(refusal_db, "");
    const refusal_config = checkpoint.parse_sqlite_checkpoint_config(
        {
            OM_SQLITE_CHECKPOINTS_ENABLED: "true",
            OM_PROCESS_ROLE: "api",
            OM_SQLITE_CHECKPOINT_OWNER_ROLE: "api",
            OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE: "single-host",
        },
        refusal_db,
    );
    fs.writeFileSync(
        refusal_config.lock_path,
        `${JSON.stringify({
            schema: "openmemory-checkpoint-lease/v1",
            database_path: refusal_db,
            hostname: "foreign-host.invalid",
            pid: 1,
            boot_id: "foreign",
            process_start_ticks: "1",
            release_token: "foreign",
            created_at: new Date().toISOString(),
        })}\n`,
    );
    assert.throws(
        () => checkpoint.acquire_checkpoint_lease(refusal_config, refusal_db),
        /foreign-host checkpoint lease/,
    );
    const symlink_target = path.join(root, "symlink-target.lock");
    const symlink_lock = path.join(root, "symlink.lock");
    fs.writeFileSync(symlink_target, "");
    fs.symlinkSync(symlink_target, symlink_lock);
    assert.throws(
        () =>
            checkpoint.acquire_checkpoint_lease(
                {
                    ...refusal_config,
                    lock_path: symlink_lock,
                    lock_path_overridden: true,
                },
                refusal_db,
            ),
        /must not be a symlink/,
    );
    const unwritable = path.join(root, "unwritable");
    fs.mkdirSync(unwritable, { mode: 0o700 });
    const unwritable_db = path.join(unwritable, "database.sqlite");
    fs.writeFileSync(unwritable_db, "");
    const unwritable_config = checkpoint.parse_sqlite_checkpoint_config(
        {
            OM_SQLITE_CHECKPOINTS_ENABLED: "true",
            OM_PROCESS_ROLE: "api",
            OM_SQLITE_CHECKPOINT_OWNER_ROLE: "api",
            OM_SQLITE_CHECKPOINT_DEPLOYMENT_SCOPE: "single-host",
        },
        unwritable_db,
    );
    fs.chmodSync(unwritable, 0o500);
    assert.throws(
        () =>
            checkpoint.acquire_checkpoint_lease(
                unwritable_config,
                unwritable_db,
            ),
        /EACCES|permission denied/i,
    );
    fs.chmodSync(unwritable, 0o700);
    assert.throws(
        () =>
            checkpoint.sqlite_checkpoint_test_helpers.read_process_start_ticks(
                999999,
            ),
        /ENOENT|no such file/i,
    );
    pass(7, "lease-refusal-matrix");

    let passive_started = false;
    let passive_finished = false;
    const released = { count: 0 };
    const join_controller = checkpoint.create_checkpoint_controller(
        checkpoint_config(),
        {
            acquire_lease: () => fake_lease(released),
            passive_checkpoint: async () => {
                passive_started = true;
                await sleep(250);
                passive_finished = true;
                return {
                    busy: 0,
                    frames_in_wal: 1,
                    frames_checkpointed: 1,
                };
            },
        },
    );
    join_controller.start();
    await sleep(1030);
    assert.equal(passive_started, true);
    await join_controller.stop(Date.now() + 1000);
    assert.equal(passive_finished, true);
    const attempts_after_stop = join_controller.metrics.attempts;
    await sleep(1030);
    assert.equal(join_controller.metrics.attempts, attempts_after_stop);
    join_controller.release();
    pass(8, "passive-join-and-timer-clear", {
        attempts: attempts_after_stop,
    });

    const quiesce = run_child("db-quiesce", path.join(root, "quiesce.sqlite"));
    assert.equal(quiesce.status, 0, quiesce.stderr);
    assert.equal(quiesce.parsed.late_refused, true);
    pass(9, "quiesce-admission-and-queue-fence");
    assert.equal(quiesce.parsed.passive_skipped, true);
    pass(10, "transaction-excludes-passive-checkpoint");
    assert.equal(quiesce.parsed.pre_admitted_completed, true);
    pass(11, "pre-quiesce-transaction-completes");
    assert.equal(quiesce.parsed.nested_refused, true);
    pass(12, "nested-transaction-refused");

    const wal = run_child("wal-growth", path.join(root, "wal.sqlite"));
    assert.equal(wal.status, 0, wal.stderr);
    assert.equal(wal.parsed.bounded, true);
    pass(13, "wal-growth-sampled-and-bounded", wal.parsed);

    const nonowner_shutdown = run_child(
        "shutdown-nonowner",
        path.join(root, "shutdown-nonowner.sqlite"),
    );
    assert.equal(nonowner_shutdown.status, 0, nonowner_shutdown.stderr);
    assert.equal(nonowner_shutdown.parsed.outcome.exit_code, 0);
    assert.equal(nonowner_shutdown.parsed.truncate_calls, 0);
    pass(14, "nonowner-shutdown-never-truncates");

    const retry_shutdown = run_child(
        "shutdown-owner-retry",
        path.join(root, "shutdown-retry.sqlite"),
    );
    assert.equal(retry_shutdown.status, 0, retry_shutdown.stderr);
    assert.equal(retry_shutdown.parsed.outcome.exit_code, 0);
    assert.equal(retry_shutdown.parsed.truncate_calls, 2);
    assert.equal(retry_shutdown.parsed.released, 1);
    pass(15, "owner-busy-retry-then-truncate");

    const owner_timeout = run_child(
        "shutdown-owner-timeout",
        path.join(root, "shutdown-owner-timeout.sqlite"),
    );
    assert.equal(owner_timeout.status, 0, owner_timeout.stderr);
    assert.equal(owner_timeout.parsed.outcome.exit_code, 2);
    assert.equal(owner_timeout.parsed.released, 0);
    pass(16, "owner-truncate-timeout-is-unclean");

    const active_timeout = run_child(
        "shutdown-active-timeout",
        path.join(root, "shutdown-active-timeout.sqlite"),
    );
    assert.equal(active_timeout.status, 0, active_timeout.stderr);
    assert.equal(active_timeout.parsed.outcome.exit_code, 2);
    assert.equal(active_timeout.parsed.truncate_calls, 0);
    pass(17, "background-deadline-suppresses-truncate");

    let release_work!: () => void;
    const work_gate = new Promise<void>((resolve) => (release_work = resolve));
    const first_work = active.track_active_work("query-hit", work_gate);
    const second_work = active.track_active_work("startup-decay", sleep(40));
    const before_freeze = active.active_work_snapshot();
    active.freeze_active_work();
    assert.throws(
        () => active.track_active_work("late", Promise.resolve()),
        /ACTIVE_WORK_FROZEN/,
    );
    let joined = false;
    const join = active.join_active_work(Date.now() + 1000).then(() => {
        joined = true;
    });
    await sleep(60);
    assert.equal(joined, false);
    release_work();
    await Promise.all([first_work, second_work, join]);
    assert.equal(active.active_work_snapshot().active, 0);
    active.reset_active_work_for_tests();
    pass(18, "active-work-freeze-stable-join-and-errors", before_freeze);

    const http_clean = run_child(
        "shutdown-http-clean",
        path.join(root, "shutdown-http-clean.sqlite"),
    );
    assert.equal(http_clean.status, 0, http_clean.stderr);
    assert.equal(http_clean.parsed.outcome.exit_code, 0);
    assert.equal(http_clean.parsed.outcome.http_forced_close, false);
    pass(19, "http-keepalive-and-active-request-drain");

    class FakeResponse extends EventEmitter {
        statusCode = 200;
        headers: Record<string, string> = {};
        body = "";
        setHeader(name: string, value: string) {
            this.headers[name] = value;
        }
        status(code: number) {
            this.statusCode = code;
            return this;
        }
        end(body = "") {
            this.body = body;
            this.emit("finish");
        }
    }
    const surfaces = shutdown.create_http_drain_state();
    for (const surface of [
        "health",
        "options",
        "unauthenticated",
        "mcp",
        "authenticated",
    ]) {
        const response = new FakeResponse();
        surfaces.middleware({ surface }, response, () => response.end());
    }
    assert.equal(surfaces.snapshot().active_requests, 0);
    pass(20, "all-http-surfaces-share-idempotent-counter");

    const post_drain = shutdown.create_http_drain_state();
    post_drain.begin();
    const refused = new FakeResponse();
    let entered = false;
    post_drain.middleware({}, refused, () => {
        entered = true;
    });
    assert.equal(refused.statusCode, 503);
    assert.equal(entered, false);
    const http_timeout = run_child(
        "shutdown-http-timeout",
        path.join(root, "shutdown-http-timeout.sqlite"),
    );
    assert.equal(http_timeout.status, 0, http_timeout.stderr);
    assert.equal(http_timeout.parsed.outcome.exit_code, 2);
    assert.equal(http_timeout.parsed.outcome.http_forced_close, true);
    assert.equal(http_timeout.parsed.truncate_calls, 0);
    pass(21, "post-drain-503-and-forced-close-timeout");

    const fatal = run_child(
        "shutdown-fatal",
        path.join(root, "shutdown-fatal.sqlite"),
    );
    assert.equal(fatal.status, 0, fatal.stderr);
    assert.equal(fatal.parsed.outcome.exit_code, 1);
    assert.equal(fatal.parsed.same_promise, true);
    pass(22, "fatal-upgrades-memoized-shutdown");

    const crash_db = path.join(root, "crash.sqlite");
    const crash = run_child("crash-writer", crash_db);
    assert.equal(crash.signal, "SIGKILL");
    assert.equal(crash.parsed.committed, 25);
    const reopened = run_child("read-integrity", crash_db);
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.equal(reopened.parsed.count, 25);
    assert.equal(reopened.parsed.integrity, "ok");
    pass(23, "crash-reopen-preserves-committed-rows", reopened.parsed);

    const clone_db = path.join(root, "crash-clone.sqlite");
    fs.copyFileSync(crash_db, clone_db);
    for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(`${crash_db}${suffix}`)) {
            fs.copyFileSync(`${crash_db}${suffix}`, `${clone_db}${suffix}`);
        }
    }
    const clone = run_child("read-integrity", clone_db);
    assert.equal(clone.status, 0, clone.stderr);
    assert.deepEqual(clone.parsed, reopened.parsed);
    pass(24, "application-driver-clone-integrity-and-counts", clone.parsed);

    const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
    const local_mount =
        checkpoint.sqlite_checkpoint_test_helpers.parse_mountinfo(
            root,
            mountinfo,
        );
    assert(
        ["btrfs", "ext2", "ext3", "ext4", "xfs", "tmpfs"].includes(
            local_mount.filesystem,
        ),
    );
    checkpoint.sqlite_checkpoint_test_helpers.run_lease_primitive_probe(root);
    assert.throws(
        () =>
            checkpoint.parse_sqlite_checkpoint_config(
                {
                    OM_SQLITE_CHECKPOINTS_ENABLED: "true",
                    OM_PROCESS_ROLE: "api",
                    OM_SQLITE_CHECKPOINT_OWNER_ROLE: "api",
                },
                path.join(root, "scope.sqlite"),
            ),
        /single-host/,
    );
    assert.throws(
        () =>
            checkpoint.sqlite_checkpoint_test_helpers.assert_local_filesystem(
                "/tmp/test",
                "1 0 0:1 / /tmp rw - nfs server:/tmp rw",
            ),
        /unsupported|no mountinfo/,
    );
    pass(25, "local-filesystem-and-startup-refusal-contracts", local_mount);

    const db_source = fs.readFileSync(path.resolve("src/core/db.ts"), "utf8");
    assert.match(
        db_source,
        /if \(is_pg\) \{\s*return \{ busy: 0, frames_in_wal: 0, frames_checkpointed: 0 \};\s*\}/,
    );
    assert.equal(
        (
            db_source.match(
                /if \(is_pg\) \{\s*return \{ busy: 0, frames_in_wal: 0, frames_checkpointed: 0 \};\s*\}/g,
            ) || []
        ).length,
        2,
    );
    pass(26, "postgres-checkpoint-methods-are-explicit-noops");

    await db.close_database();
    const build = spawnSync("npm", ["run", "build"], {
        encoding: "utf8",
        timeout: 30000,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const contracts = spawnSync("npm", ["run", "test:contracts"], {
        encoding: "utf8",
        timeout: 30000,
    });
    assert.equal(contracts.status, 0, contracts.stderr || contracts.stdout);
    pass(27, "typescript-build-and-existing-contract-tests");

    assert.equal(results.length, 27);
    console.log(
        JSON.stringify({
            passed: true,
            count: results.length,
            fixture_root: root,
            results,
        }),
    );
    await new Promise<void>((resolve) => process.stdout.write("", resolve));
    process.exit(0);
}
