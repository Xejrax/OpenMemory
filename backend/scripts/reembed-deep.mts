// reembed-deep.mts — one-shot store migration: synthetic-256 → semantic-256 (deep tier).
// STAGED 2026-07-23 (session 3517d54d) — RUN ONLY ON RZ's EXPLICIT GO (memory-store
// rewrite = §19 surgery class; auto-mode classifier correctly held it for a named yes).
//
// Runs OM's OWN embedForSector (no reimplementation). Migration uses NO synthetic
// fallback: any embed failure throws and aborts, leaving the backups authoritative.
// Backups already on disk: openmemory.sqlite.bak-pre-semantic-* and *-post-checkpoint-*.
//
// Run:  cd ~/BrainZ/repos/openmemory/backend && npx tsx scripts/reembed-deep.mts
process.env.OM_TIER = "deep";
process.env.OM_EMBEDDINGS = "ollama";
process.env.OM_EMBEDDING_FALLBACK = "ollama"; // fail LOUD during migration
process.env.OM_VEC_DIM = "256";
process.env.OM_OLLAMA_URL = "http://localhost:11434";
process.env.OM_DB_PATH = "/var/mnt/xdata/BrainZ/openmemory/openmemory.sqlite";

const { embedForSector } = await import("../src/memory/embed");
const sqlite3 = (await import("sqlite3")).default;
const db = new sqlite3.Database(process.env.OM_DB_PATH!);
const all = (q: string, p: any[] = []) =>
    new Promise<any[]>((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
const run = (q: string, p: any[] = []) =>
    new Promise<void>((res, rej) => db.run(q, p, (e) => (e ? rej(e) : res())));

const rows = await all(
    "SELECT v.id, v.sector, m.content FROM vectors v JOIN memories m ON m.id = v.id");
console.log(`re-embedding ${rows.length} sector-vectors (deep/ollama → 256d)…`);
let done = 0;
for (const r of rows) {
    const vec = await embedForSector(String(r.content ?? ""), r.sector);
    const buf = Buffer.from(new Float32Array(vec).buffer);
    await run("UPDATE vectors SET v = ?, dim = ? WHERE id = ? AND sector = ?",
        [buf, vec.length, r.id, r.sector]);
    if (++done % 50 === 0 || done === rows.length) console.log(`  ${done}/${rows.length}`);
}
await run("PRAGMA wal_checkpoint(TRUNCATE)");
console.log("migration complete — restart openmemory.service and re-run the paraphrase e2e");
db.close();
