// bind_hosts.ts — OM_HOST parsing (bazz-h835k.10.2.1).
//
// OM_HOST is an optional, comma-separated list of bind addresses for the
// OpenMemory HTTP server, e.g. "127.0.0.1" or "127.0.0.1,100.91.53.26".
// Unset or blank returns [] and the server keeps its historical default
// (listen(port) on all interfaces). Kept dependency-free so it can be tested
// without loading cfg.ts (which reads .env and tier settings).
export const parse_bind_hosts = (v: string | undefined): string[] => {
    if (v === undefined || v === null) return [];
    const out: string[] = [];
    for (const raw of String(v).split(",")) {
        const h = raw.trim();
        if (h && !out.includes(h)) out.push(h);
    }
    return out;
};
