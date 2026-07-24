import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const NOMIN_MODEL = "nomic-ai/nomic-embed-text-v1";
const SEMANTIC_DIM = 768;
const TOKEN_CAP = 1024;

type MockMode = "valid" | "wrong-dimension";

async function startFastEmbedMock() {
    let mode: MockMode = "valid";
    const kinds: string[] = [];
    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
            if (request.method !== "POST" || request.url !== "/embed_nomic") {
                response.writeHead(404).end();
                return;
            }

            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            kinds.push(body.kind);
            const dimension = mode === "valid" ? SEMANTIC_DIM : 384;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    model: NOMIN_MODEL,
                    dim: dimension,
                    token_cap: TOKEN_CAP,
                    vec: Array.from(
                        { length: dimension },
                        (_, index) => (index + 1) / dimension,
                    ),
                }),
            );
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert(address && typeof address === "object");

    return {
        url: `http://127.0.0.1:${address.port}`,
        kinds,
        setMode(next: MockMode) {
            mode = next;
        },
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
    };
}

function configureTestProcess(dbPath: string, fastEmbedUrl: string) {
    Object.assign(process.env, {
        OM_DB_PATH: dbPath,
        OM_METADATA_BACKEND: "sqlite",
        OM_VECTOR_BACKEND: "postgres",
        OM_TIER: "deep",
        OM_EMBEDDINGS: "fastembed",
        // Deliberately leave synthetic configured as the nominal fallback. In
        // strict mode it must never be consulted.
        OM_EMBEDDING_FALLBACK: "synthetic",
        OM_EMBEDDING_STRICT: "true",
        OM_FASTEMBED_URL: fastEmbedUrl,
        OM_FASTEMBED_MODEL: NOMIN_MODEL,
        OM_SEMANTIC_VEC_DIM: String(SEMANTIC_DIM),
        OM_SYNTHETIC_VEC_DIM: "256",
        OM_SMART_COMPRESSED_DIM: "128",
        OM_DECAY_FINGERPRINT_DIM: "32",
        OM_DECAY_REGEN_MAX_DIM: "64",
        OM_EMBEDDING_MAX_TOKENS: String(TOKEN_CAP),
        OM_EMBEDDING_TIMEOUT_MS: "250",
        OM_EMBEDDING_STARTUP_TIMEOUT_MS: "1000",
        OM_DECAY_ON_STARTUP: "false",
    });
    delete process.env.OM_VEC_DIM;
}

async function verifyFastEmbedContract(
    mock: Awaited<ReturnType<typeof startFastEmbedMock>>,
) {
    const { env } = await import("../src/core/cfg.ts");
    const { embedForSector, getEmbeddingInfo, runEmbeddingStartupCanary } =
        await import("../src/memory/embed.ts");

    assert.equal(env.decay_on_startup, false);
    assert.equal(env.embedding_strict, true);
    assert.equal(env.semantic_vec_dim, SEMANTIC_DIM);

    const info = getEmbeddingInfo();
    assert.equal(info.provider, "fastembed");
    assert.equal(info.strict, true);
    assert.equal(info.dimensions, SEMANTIC_DIM);
    assert.equal(info.model, NOMIN_MODEL);
    assert.equal(info.document_query_contract, true);

    const readiness = await runEmbeddingStartupCanary();
    assert.deepEqual(readiness, {
        provider: "fastembed",
        model: NOMIN_MODEL,
        dimension: SEMANTIC_DIM,
        strict: true,
    });
    assert.deepEqual(mock.kinds.slice(-2), ["document", "query"]);

    mock.setMode("wrong-dimension");
    await assert.rejects(
        embedForSector("dimension mismatch canary", "semantic", "document"),
        /Strict embedding provider fastembed failed: FastEmbed model\/dimension contract mismatch/,
    );

    mock.setMode("valid");
    await mock.close();
    await assert.rejects(
        embedForSector("provider loss canary", "semantic", "document"),
        /Strict embedding provider fastembed failed:/,
    );
}

async function verifySqliteIdFirstContract() {
    const { q, vectorToBuffer } = {
        ...(await import("../src/core/db.ts")),
        ...(await import("../src/memory/embed.ts")),
    };
    const now = Date.now();
    const targetId = "00000000-0000-4000-8000-000000000001";
    const controlId = "00000000-0000-4000-8000-000000000002";

    const insert = (id: string, content: string) =>
        q.ins_mem.run(
            id,
            "contract-test-user",
            0,
            content,
            `simhash-${id}`,
            "semantic",
            "[]",
            "{}",
            now,
            now,
            now,
            1.0,
            0.02,
            1,
            null,
            null,
            null,
            0,
        );
    await insert(targetId, "target row");
    await insert(controlId, "control row");

    const meanVector = vectorToBuffer(
        Array.from({ length: SEMANTIC_DIM }, (_, index) => index / 1000),
    );
    const compressedVector = vectorToBuffer(
        Array.from({ length: 128 }, (_, index) => index / 100),
    );
    const nextSeen = now + 10_000;
    const nextUpdated = now + 20_000;

    await q.upd_mean_vec.run(targetId, SEMANTIC_DIM, meanVector);
    await q.upd_compressed_vec.run(targetId, compressedVector);
    await q.upd_seen.run(targetId, nextSeen, 0.42, nextUpdated);

    const target = await q.get_mem.get(targetId);
    const control = await q.get_mem.get(controlId);
    assert(target, "target row must still exist");
    assert(control, "control row must still exist");
    assert.equal(target.mean_dim, SEMANTIC_DIM);
    assert.deepEqual(Buffer.from(target.mean_vec), meanVector);
    assert.deepEqual(Buffer.from(target.compressed_vec), compressedVector);
    assert.equal(target.last_seen_at, nextSeen);
    assert.equal(target.salience, 0.42);
    assert.equal(target.updated_at, nextUpdated);

    assert.equal(control.mean_dim, null);
    assert.equal(control.mean_vec, null);
    assert.equal(control.compressed_vec, null);
    assert.equal(control.last_seen_at, now);
    assert.equal(control.salience, 1.0);
    assert.equal(control.updated_at, now);
}

async function main() {
    const testRoot = await mkdtemp(
        path.join(tmpdir(), "openmemory-contract-test-"),
    );
    const dbPath = path.join(testRoot, "openmemory.sqlite");
    const mock = await startFastEmbedMock();
    configureTestProcess(dbPath, mock.url);

    try {
        await verifyFastEmbedContract(mock);
        await verifySqliteIdFirstContract();
        console.log(
            JSON.stringify({
                passed: true,
                fastembed: {
                    model: NOMIN_MODEL,
                    dimension: SEMANTIC_DIM,
                    strict_provider_loss: "rejected",
                    wrong_dimension: "rejected",
                    canary_kinds: ["document", "query"],
                },
                sqlite: {
                    contract: "id-first",
                    operations: [
                        "upd_seen",
                        "upd_mean_vec",
                        "upd_compressed_vec",
                    ],
                    control_row_unchanged: true,
                },
                decay_on_startup: false,
            }),
        );
    } finally {
        await mock.close().catch(() => undefined);
        await rm(testRoot, { recursive: true, force: true });
    }
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
