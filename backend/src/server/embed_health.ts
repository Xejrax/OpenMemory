// embed_health.ts — cached, short-timeout reachability check of the embedding provider for
// GET /health (beads-d8luz.7.1, incident bazz-h835k.10.2.1.1).
//
// Incident: fastembed (127.0.0.1:7077) wedged at its cgroup MemoryHigh on VPS-NC; OM's
// /health kept answering {ok:true} while every embed failed and an OM restart then crash-
// looped on the strict startup canary. /health now reports the provider:
//   provider reachable   -> 200 {ok:true,  status:"ok",       embed:"up",   ...}
//   provider unreachable -> 503 {ok:false, status:"degraded", embed:"down", ...}
//   provider not probed  -> 200 {ok:true,  status:"ok",       embed:"not_checked", ...}
//                           (synthetic / cloud providers: unchanged behaviour)
// The probe is a GET on the provider's own health endpoint (never an embed), bounded by
// timeout_ms, cached for ttl_ms and single-flighted, so /health stays cheap under polling and a
// wedged provider costs at most one timeout per TTL window.

export type EmbedState = "up" | "down" | "not_checked";

export interface EmbedCheck {
    embed: EmbedState;
    provider: string;
    url?: string;
    checked_at: number;
    latency_ms: number | null;
    cached: boolean;
    error?: string;
}

export interface EmbedHealthOptions {
    provider: string;
    url: string;
    timeout_ms?: number;
    ttl_ms?: number;
    fetch_impl?: typeof fetch;
    now?: () => number;
}

const PROBES: Record<string, { path: string; healthy: (status: number, body: any) => boolean }> = {
    // fastembed-service contract: GET /health -> {"status":"ok","models":{"nomic":{"loaded":true}}}
    fastembed: {
        path: "/health",
        healthy: (status, body) =>
            status >= 200 &&
            status < 300 &&
            body?.status === "ok" &&
            body?.models?.nomic?.loaded !== false,
    },
    ollama: { path: "/api/version", healthy: (status) => status >= 200 && status < 300 },
};

export function createEmbedHealthChecker(opts: EmbedHealthOptions) {
    const timeout_ms = opts.timeout_ms ?? 1500;
    const ttl_ms = opts.ttl_ms ?? 10000;
    const fetch_impl = opts.fetch_impl ?? fetch;
    const now = opts.now ?? Date.now;
    const probe = PROBES[opts.provider];
    const base = (opts.url || "").replace(/\/$/, "");
    let last: EmbedCheck | null = null;
    let inflight: Promise<EmbedCheck> | null = null;
    let probes = 0;

    async function run(): Promise<EmbedCheck> {
        probes++;
        const started = now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms);
        try {
            const r = await fetch_impl(base + probe!.path, { signal: controller.signal });
            let body: any = null;
            try {
                body = await r.json();
            } catch {
                body = null;
            }
            const up = probe!.healthy(r.status, body);
            return {
                embed: up ? "up" : "down",
                provider: opts.provider,
                url: base,
                checked_at: started,
                latency_ms: now() - started,
                cached: false,
                ...(up ? {} : { error: `http ${r.status}${body?.status ? ` status=${body.status}` : ""}` }),
            };
        } catch (e: any) {
            return {
                embed: "down",
                provider: opts.provider,
                url: base,
                checked_at: started,
                latency_ms: now() - started,
                cached: false,
                error: e?.name === "AbortError" ? `timeout after ${timeout_ms}ms` : String(e?.cause?.code ?? e?.message ?? e),
            };
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        get probe_count() {
            return probes;
        },
        async check(): Promise<EmbedCheck> {
            if (!probe || !base) {
                return { embed: "not_checked", provider: opts.provider, checked_at: now(), latency_ms: null, cached: false };
            }
            if (last && now() - last.checked_at < ttl_ms) return { ...last, cached: true };
            if (!inflight) {
                inflight = run().then((res) => {
                    last = res;
                    inflight = null;
                    return res;
                });
            }
            return inflight;
        },
    };
}

export function buildHealth(
    base: Record<string, any>,
    embed: EmbedCheck,
    degraded_http = 503,
): { code: number; body: Record<string, any> } {
    const down = embed.embed === "down";
    return {
        code: down ? degraded_http : 200,
        body: {
            ok: !down,
            status: down ? "degraded" : "ok",
            embed: embed.embed,
            embed_check: embed,
            ...base,
        },
    };
}

export function healthHandler(
    checker: { check(): Promise<EmbedCheck> },
    base: () => Record<string, any>,
    degraded_http = 503,
) {
    return async (_req: any, res: any) => {
        const { code, body } = buildHealth(base(), await checker.check(), degraded_http);
        res.status(code).json(body);
    };
}
