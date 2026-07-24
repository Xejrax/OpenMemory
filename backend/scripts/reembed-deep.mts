/**
 * OpenMemory deep-tier embedding migration.
 *
 * Audit is the default. Mutation requires --execute and an explicit database
 * path. The migration uses OpenMemory's production storage plan, classifier,
 * chunker, embedding provider, vector store, and transaction layer.
 *
 * Examples:
 *   npx tsx scripts/reembed-deep.mts --db-path /path/to/clone.sqlite
 *   npx tsx scripts/reembed-deep.mts --db-path /path/to/clone.sqlite --execute
 *   npx tsx scripts/reembed-deep.mts --db-path /path/to/clone.sqlite \
 *     --scope all --execute
 */
import fs from "node:fs";
import path from "node:path";

type Scope = "residual" | "all";

const args = process.argv.slice(2);
const valueAfter = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
};
const execute = args.includes("--execute");
const dbPathArg = valueAfter("--db-path");
const scope = (valueAfter("--scope") || "residual") as Scope;
const expectedCountArg = valueAfter("--expected-count");
const allowed = new Set([
    "--execute",
    "--db-path",
    "--scope",
    "--expected-count",
]);
for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--") || !allowed.has(arg)) {
        throw new Error(`unknown argument: ${arg}`);
    }
    if (["--db-path", "--scope", "--expected-count"].includes(arg)) index++;
}
if (!dbPathArg) {
    throw new Error(
        "--db-path is required; implicit live-store targets are refused",
    );
}
if (!["residual", "all"].includes(scope)) {
    throw new Error("--scope must be residual or all");
}
const dbPath = path.resolve(dbPathArg);
if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    throw new Error(`database target is not an existing file: ${dbPath}`);
}
const expectedCount = expectedCountArg
    ? Number.parseInt(expectedCountArg, 10)
    : undefined;
if (
    expectedCount !== undefined &&
    (!Number.isInteger(expectedCount) || expectedCount < 0)
) {
    throw new Error("--expected-count must be a non-negative integer");
}

process.env.OM_DB_PATH = dbPath;
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "postgres";
process.env.OM_TIER = "deep";
process.env.OM_EMBEDDINGS = "fastembed";
process.env.OM_EMBEDDING_FALLBACK = "fastembed";
process.env.OM_EMBEDDING_STRICT = "true";
process.env.OM_SEMANTIC_VEC_DIM = process.env.OM_SEMANTIC_VEC_DIM || "768";
process.env.OM_SYNTHETIC_VEC_DIM = process.env.OM_SYNTHETIC_VEC_DIM || "256";
process.env.OM_SMART_COMPRESSED_DIM =
    process.env.OM_SMART_COMPRESSED_DIM || "128";
process.env.OM_DECAY_FINGERPRINT_DIM =
    process.env.OM_DECAY_FINGERPRINT_DIM || "32";
process.env.OM_DECAY_REGEN_MAX_DIM = process.env.OM_DECAY_REGEN_MAX_DIM || "64";
delete process.env.OM_VEC_DIM;

const [{ env }, db, hsg, embed] = await Promise.all([
    import("../src/core/cfg"),
    import("../src/core/db"),
    import("../src/memory/hsg"),
    import("../src/memory/embed"),
]);
const { q, transaction, vector_store } = db;
const { calc_mean_vec, embedContentForStorage } = hsg;
const { vectorToBuffer, runEmbeddingStartupCanary } = embed;

const parseMetadata = (raw: unknown) => {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
        return JSON.parse(String(raw));
    } catch {
        return {};
    }
};

const memories = await q.all_mem.all(1_000_000, 0);
if (expectedCount !== undefined && memories.length !== expectedCount) {
    throw new Error(
        `expected ${expectedCount} memories but target contains ${memories.length}`,
    );
}

const census = [];
for (const memory of memories) {
    const vectors = await vector_store.getVectorsById(memory.id);
    const residual =
        memory.mean_vec == null ||
        memory.mean_dim !== env.semantic_vec_dim ||
        vectors.length === 0 ||
        vectors.some((vector) => vector.dim !== env.semantic_vec_dim);
    census.push({
        memory,
        vectors,
        residual,
    });
}
const selected = census.filter((row) => scope === "all" || row.residual);
const audit = {
    mode: execute ? "execute" : "audit",
    target: dbPath,
    scope,
    provider: env.emb_kind,
    strict: env.embedding_strict,
    semantic_dimension: env.semantic_vec_dim,
    memories: memories.length,
    vectors: census.reduce((sum, row) => sum + row.vectors.length, 0),
    residual_memories: census.filter((row) => row.residual).length,
    selected_memories: selected.length,
    dimensions_before: census.reduce<Record<string, number>>((acc, row) => {
        for (const vector of row.vectors) {
            const key = String(vector.dim);
            acc[key] = (acc[key] || 0) + 1;
        }
        return acc;
    }, {}),
};
console.log(JSON.stringify(audit, null, 2));
if (!execute) {
    console.log("AUDIT ONLY — pass --execute to mutate this explicit target");
    process.exit(0);
}

await runEmbeddingStartupCanary();
const precomputed = [];
let prepared = 0;
for (const row of selected) {
    const memory = row.memory;
    const metadata = parseMetadata(memory.meta);
    try {
        const { plan, embeddings } = await embedContentForStorage(
            memory.id,
            String(memory.content || ""),
            metadata,
            { write_log: false },
        );
        const meanVector = calc_mean_vec(embeddings, plan.sectors);
        precomputed.push({
            memory,
            plan,
            embeddings,
            meanVector,
        });
    } catch (error) {
        throw new Error(
            `precompute failed at memory ${memory.id} after ${prepared} preparations; target remains untouched`,
            { cause: error },
        );
    }
    prepared++;
    if (prepared % 25 === 0 || prepared === selected.length) {
        console.log(`PRECOMPUTE ${prepared}/${selected.length}`);
    }
}

let applied = 0;
await transaction.begin();
try {
    for (const item of precomputed) {
        const { memory, plan, embeddings, meanVector } = item;
        await vector_store.deleteVectors(memory.id);
        for (const result of embeddings) {
            await vector_store.storeVector(
                memory.id,
                result.sector,
                result.vector,
                result.dim,
                memory.user_id || "anonymous",
            );
        }
        await q.upd_mean_vec.run(
            memory.id,
            meanVector.length,
            vectorToBuffer(meanVector),
        );
        await q.upd_compressed_vec.run(memory.id, null);
        await q.upd_primary_sector.run(memory.id, plan.primary);
        applied++;
        if (applied % 25 === 0 || applied === precomputed.length) {
            console.log(`APPLY ${applied}/${precomputed.length}`);
        }
    }
    await transaction.commit();
} catch (error) {
    await transaction.rollback();
    throw new Error(
        `atomic apply failed after ${applied} staged updates; all updates rolled back`,
        { cause: error },
    );
}

const after = [];
for (const memory of await q.all_mem.all(1_000_000, 0)) {
    const vectors = await vector_store.getVectorsById(memory.id);
    after.push({ memory, vectors });
}
const invalid = after.filter(
    (row) =>
        row.memory.mean_dim !== env.semantic_vec_dim ||
        row.memory.mean_vec == null ||
        row.vectors.length === 0 ||
        row.vectors.some(
            (vector) =>
                vector.dim !== env.semantic_vec_dim ||
                vector.vector.length !== env.semantic_vec_dim ||
                vector.vector.some((value) => !Number.isFinite(value)),
        ),
);
if (invalid.length > 0) {
    throw new Error(
        `post-migration contract failed for ${invalid.length} memories`,
    );
}
console.log(
    JSON.stringify(
        {
            verdict: "PASS",
            migrated_memories: applied,
            verified_memories: after.length,
            dimension: env.semantic_vec_dim,
            provider: env.emb_kind,
        },
        null,
        2,
    ),
);
process.exit(0);
