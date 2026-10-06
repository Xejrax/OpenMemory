// verify_om_host_bind.mts — OM_HOST bind contract (bazz-h835k.10.2.1).
// Run: npx tsx tests/verify_om_host_bind.mts   (exit 0 = all pass)
//
//  1. OM_HOST unset/blank  -> parse_bind_hosts() === []  (default path)
//  2. default listen(port) -> unspecified wildcard bind (:: or 0.0.0.0), unchanged
//  3. OM_HOST=127.0.0.1    -> bound address is exactly 127.0.0.1 and serves requests
//  4. multi-host list      -> every listed address bound, same handlers on each
//  5. index.ts keeps the bare app.listen(env.port, ...) path when OM_HOST is unset
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const server = require("../src/server/server.js");
const bind_hosts_mod: any = await import("../src/core/bind_hosts.ts");
const parse_bind_hosts: (v: string | undefined) => string[] =
    bind_hosts_mod.parse_bind_hosts ?? bind_hosts_mod.default?.parse_bind_hosts;

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

function get(host: string, port: number, p: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host, port, path: p, timeout: 3000 }, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
    });
}

function mkApp() {
    const app = server({});
    app.all("/health", (_req: any, res: any) => res.json({ ok: true }));
    return app;
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

await t("OM_HOST unset -> []", () => {
    assert.deepEqual(parse_bind_hosts(undefined), []);
});
await t("OM_HOST blank/whitespace -> []", () => {
    assert.deepEqual(parse_bind_hosts(""), []);
    assert.deepEqual(parse_bind_hosts("  ,  "), []);
});
await t("OM_HOST list parsed, trimmed, de-duplicated", () => {
    assert.deepEqual(parse_bind_hosts("127.0.0.1"), ["127.0.0.1"]);
    assert.deepEqual(parse_bind_hosts(" 127.0.0.1 , 100.91.53.26,127.0.0.1"), ["127.0.0.1", "100.91.53.26"]);
});

await t("default listen(port) binds the unspecified wildcard (unchanged)", async () => {
    const app = mkApp();
    const port = await freePort();
    await new Promise<void>((r) => app.listen(port, () => r()));
    try {
        const addrs = app.addresses();
        assert.equal(addrs.length, 1);
        assert.ok(["::", "0.0.0.0"].includes(addrs[0].address), `got ${addrs[0].address}`);
        const r = await get("127.0.0.1", port, "/health");
        assert.equal(r.status, 200);
    } finally {
        await new Promise<void>((r) => app.close(() => r()));
    }
});

await t("listenHosts(port, []) falls back to the default wildcard bind", async () => {
    const app = mkApp();
    const port = await freePort();
    await new Promise<void>((r) => app.listenHosts(port, [], () => r()));
    try {
        assert.ok(["::", "0.0.0.0"].includes(app.addresses()[0].address));
    } finally {
        await new Promise<void>((r) => app.close(() => r()));
    }
});

await t("OM_HOST=127.0.0.1 binds exactly 127.0.0.1 and serves", async () => {
    const app = mkApp();
    const port = await freePort();
    await new Promise<void>((r) => app.listenHosts(port, parse_bind_hosts("127.0.0.1"), () => r()));
    try {
        const addrs = app.addresses();
        assert.deepEqual(addrs.map((a: any) => a.address), ["127.0.0.1"]);
        const r = await get("127.0.0.1", port, "/health");
        assert.equal(r.status, 200);
        assert.equal(JSON.parse(r.body).ok, true);
    } finally {
        await new Promise<void>((r) => app.close(() => r()));
    }
});

await t("multi-host OM_HOST binds every address with the same handlers", async () => {
    const app = mkApp();
    const port = await freePort();
    // 127.0.0.2 is loopback on Linux; stands in for the tailnet address.
    await new Promise<void>((r) => app.listenHosts(port, parse_bind_hosts("127.0.0.1,127.0.0.2"), () => r()));
    try {
        assert.deepEqual(app.addresses().map((a: any) => a.address).sort(), ["127.0.0.1", "127.0.0.2"]);
        for (const h of ["127.0.0.1", "127.0.0.2"]) {
            const r = await get(h, port, "/health");
            assert.equal(r.status, 200, `host ${h}`);
        }
    } finally {
        await new Promise<void>((r) => app.close(() => r()));
    }
});

await t("index.ts keeps bare app.listen(env.port, ...) when OM_HOST is unset", () => {
    const src = readFileSync(path.join(here, "../src/server/index.ts"), "utf8");
    assert.match(src, /if \(env\.hosts\.length === 0\) \{[\s\S]*?app\.listen\(env\.port, on_listening\);/);
    assert.match(src, /app\.listenHosts\(env\.port, env\.hosts, on_listening\)/);
    const cfg = readFileSync(path.join(here, "../src/core/cfg.ts"), "utf8");
    assert.match(cfg, /hosts: parse_bind_hosts\(process\.env\.OM_HOST\)/);
    assert.match(cfg, /port: num\(process\.env\.OM_PORT, 8080\)/);
});

for (const line of results) console.log(line);
console.log(`om-host-bind: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
