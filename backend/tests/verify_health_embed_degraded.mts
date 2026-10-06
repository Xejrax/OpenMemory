// verify_health_embed_degraded.mts — /health reports the embedding provider (beads-d8luz.7.1,
// incident bazz-h835k.10.2.1.1: fastembed wedged while OM /health said ok:true).
// Run: npx tsx tests/verify_health_embed_degraded.mts   (exit 0 = all pass). Hermetic: fake
// fastembed servers on 127.0.0.1 ephemeral ports, no DB, no real provider.
//
//  1. provider up                     -> embed "up", /health 200 {ok:true,status:"ok"}
//  2. provider refused (port closed)  -> /health 503 {ok:false,status:"degraded",embed:"down"}
//  3. provider wedged (never answers) -> down within timeout_ms (short), not the 10s embed timeout
//  4. provider 503 / status!="ok" / nomic not loaded -> down
//  5. cached: polls inside ttl_ms hit the provider once; after ttl it re-probes
//  6. single-flight: concurrent /health calls share one probe
//  7. synthetic/cloud provider -> "not_checked", 200 (unchanged behaviour)
//  8. OM_HEALTH_DEGRADED_HTTP-style override (200) keeps the degraded body
//  9. system.ts wires /health through healthHandler with the env knobs
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const server = require("../src/server/server.js");
const mod: any = await import("../src/server/embed_health.ts");
const createEmbedHealthChecker = mod.createEmbedHealthChecker ?? mod.default?.createEmbedHealthChecker;
const healthHandler = mod.healthHandler ?? mod.default?.healthHandler;
const buildHealth = mod.buildHealth ?? mod.default?.buildHealth;

let pass = 0;
let fail = 0;
const results: string[] = [];
async function t(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        pass++;
        results.push(`ok   ${name}`);
    } catch (e: any) {
        fail++;
        results.push(`FAIL ${name}: ${e?.message ?? e}`);
    }
}

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = (s.address() as any).port;
            s.close(() => resolve(p));
        });
    });
}

type Mode = "ok" | "http503" | "degraded" | "nomic_unloaded" | "hang";
async function fakeFastembed(mode: Mode) {
    let hits = 0;
    const hung: http.ServerResponse[] = [];
    const s = http.createServer((req, res) => {
        hits++;
        if (mode === "hang") {
            hung.push(res);
            return;
        }
        const body =
            mode === "ok"
                ? { status: "ok", models: { nomic: { loaded: true } } }
                : mode === "nomic_unloaded"
                  ? { status: "ok", models: { nomic: { loaded: false } } }
                  : { status: "degraded" };
        res.writeHead(mode === "http503" ? 503 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as any).port;
    return {
        url: `http://127.0.0.1:${port}`,
        get hits() {
            return hits;
        },
        close: () =>
            new Promise<void>((r) => {
                for (const res of hung) res.destroy();
                s.closeAllConnections?.();
                s.close(() => r());
            }),
    };
}

function get(port: number, p: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 5000 }, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
    });
}

async function omWith(checker: any, degraded_http = 503) {
    const app = server({});
    app.get("/health", healthHandler(checker, () => ({ version: "2.0-hsg-tiered", tier: "test" }), degraded_http));
    const port = await freePort();
    await new Promise<void>((r) => app.listen(port, () => r()));
    return { port, close: () => new Promise<void>((r) => app.close(() => r())) };
}

await t("provider up -> /health 200 ok, embed up, existing fields kept", async () => {
    const fe = await fakeFastembed("ok");
    const om = await omWith(createEmbedHealthChecker({ provider: "fastembed", url: fe.url, timeout_ms: 500 }));
    try {
        const r = await get(om.port, "/health");
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.status, "ok");
        assert.equal(r.body.embed, "up");
        assert.equal(r.body.version, "2.0-hsg-tiered");
    } finally {
        await om.close();
        await fe.close();
    }
});

await t("provider refused -> /health 503 degraded, embed down", async () => {
    const dead = await freePort();
    const om = await omWith(createEmbedHealthChecker({ provider: "fastembed", url: `http://127.0.0.1:${dead}`, timeout_ms: 500 }));
    try {
        const r = await get(om.port, "/health");
        assert.equal(r.status, 503);
        assert.equal(r.body.ok, false);
        assert.equal(r.body.status, "degraded");
        assert.equal(r.body.embed, "down");
        assert.ok(r.body.embed_check.error, "error recorded");
    } finally {
        await om.close();
    }
});

await t("provider wedged (accepts, never answers) -> down within short timeout", async () => {
    const fe = await fakeFastembed("hang");
    const c = createEmbedHealthChecker({ provider: "fastembed", url: fe.url, timeout_ms: 300 });
    try {
        const t0 = Date.now();
        const res = await c.check();
        const dt = Date.now() - t0;
        assert.equal(res.embed, "down");
        assert.match(res.error, /timeout after 300ms/);
        assert.ok(dt < 1500, `took ${dt}ms`);
    } finally {
        await fe.close();
    }
});

for (const mode of ["http503", "degraded", "nomic_unloaded"] as Mode[]) {
    await t(`provider ${mode} -> down`, async () => {
        const fe = await fakeFastembed(mode);
        try {
            const res = await createEmbedHealthChecker({ provider: "fastembed", url: fe.url, timeout_ms: 500 }).check();
            assert.equal(res.embed, "down");
        } finally {
            await fe.close();
        }
    });
}

await t("cached within ttl, re-probed after ttl", async () => {
    const fe = await fakeFastembed("ok");
    let clock = 1_000_000;
    const c = createEmbedHealthChecker({ provider: "fastembed", url: fe.url, ttl_ms: 10_000, now: () => clock });
    try {
        const a = await c.check();
        clock += 5_000;
        const b = await c.check();
        assert.equal(a.cached, false);
        assert.equal(b.cached, true);
        assert.equal(fe.hits, 1);
        clock += 6_000;
        const d = await c.check();
        assert.equal(d.cached, false);
        assert.equal(fe.hits, 2);
    } finally {
        await fe.close();
    }
});

await t("single-flight: 10 concurrent checks -> 1 probe", async () => {
    const fe = await fakeFastembed("ok");
    const c = createEmbedHealthChecker({ provider: "fastembed", url: fe.url });
    try {
        const all = await Promise.all(Array.from({ length: 10 }, () => c.check()));
        assert.ok(all.every((x: any) => x.embed === "up"));
        assert.equal(fe.hits, 1);
        assert.equal(c.probe_count, 1);
    } finally {
        await fe.close();
    }
});

await t("synthetic / cloud providers -> not_checked, 200 (unchanged)", async () => {
    for (const provider of ["synthetic", "openai", "gemini"]) {
        const c = createEmbedHealthChecker({ provider, url: "http://127.0.0.1:1" });
        const res = await c.check();
        assert.equal(res.embed, "not_checked");
        const h = buildHealth({ v: 1 }, res);
        assert.equal(h.code, 200);
        assert.equal(h.body.ok, true);
        assert.equal(c.probe_count, 0);
    }
});

await t("degraded HTTP override (200) keeps degraded body", async () => {
    const dead = await freePort();
    const om = await omWith(createEmbedHealthChecker({ provider: "fastembed", url: `http://127.0.0.1:${dead}`, timeout_ms: 300 }), 200);
    try {
        const r = await get(om.port, "/health");
        assert.equal(r.status, 200);
        assert.equal(r.body.status, "degraded");
        assert.equal(r.body.embed, "down");
    } finally {
        await om.close();
    }
});

await t("system.ts wires /health through healthHandler + env knobs", () => {
    const src = readFileSync(path.join(here, "../src/server/routes/system.ts"), "utf8");
    assert.match(src, /createEmbedHealthChecker\(\{/);
    assert.match(src, /"\/health",\s*healthHandler\(/);
    assert.match(src, /OM_HEALTH_EMBED_TIMEOUT_MS, 1500/);
    assert.match(src, /OM_HEALTH_EMBED_CACHE_MS, 10000/);
    assert.match(src, /OM_HEALTH_DEGRADED_HTTP, 503/);
    assert.match(src, /env\.fastembed_url/);
});

for (const line of results) console.log(line);
console.log(`health-embed-degraded: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
