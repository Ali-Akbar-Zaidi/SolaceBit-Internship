import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

/**
 * Supabase Postgres access layer.
 *
 * Everything server-side goes through a single pooled `pg` connection using
 * DATABASE_URL. That role bypasses RLS, which is what we want for indexing;
 * the anon/publishable key is deliberately not used here because it is
 * read-only by policy and cannot write embeddings.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../../db/schema.sql");

export const EMBED_DIMENSIONS = Number(process.env.EMBED_DIMENSIONS) || 768;

if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Add your Supabase Postgres connection string to .env."
    );
}

/**
 * Supabase's pooler terminates TLS with a certificate chain that Node does not
 * trust by default. Verification is relaxed for the hosted pooler only; the
 * transport is still encrypted.
 */
const isSupabasePooler = /pooler\.supabase\.com/i.test(process.env.DATABASE_URL);

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isSupabasePooler ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: "website-rag-chatbot",
});

pool.on("error", (error) => {
    // An idle client dying must not take the process down.
    console.error("Postgres pool error:", error.message);
});

/** Runs a parameterised query and returns the rows. */
export async function query(text, params = []) {
    const result = await pool.query(text, params);
    return result.rows;
}

/** Runs a query expected to return at most one row. */
export async function queryOne(text, params = []) {
    const rows = await query(text, params);
    return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction on a dedicated client.
 * Rolls back on any thrown error and always releases the client.
 */
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
    } catch (error) {
        await client.query("rollback").catch(() => { });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * pgvector accepts vectors as a string literal like '[0.1,0.2,...]'.
 * Validates length and rejects non-finite values, which would otherwise be
 * silently stored as NaN and poison every future similarity search.
 */
export function toVectorLiteral(embedding) {
    if (!Array.isArray(embedding)) {
        throw new Error("Embedding must be an array");
    }
    if (embedding.length !== EMBED_DIMENSIONS) {
        throw new Error(
            `Embedding must have ${EMBED_DIMENSIONS} dimensions, received ${embedding.length}`
        );
    }
    for (const value of embedding) {
        if (!Number.isFinite(value)) {
            throw new Error("Embedding contains a non-finite value");
        }
    }
    return `[${embedding.join(",")}]`;
}

/** Applies db/schema.sql. Idempotent - safe to run on every boot. */
export async function migrate() {
    const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
    const client = await pool.connect();
    try {
        await client.query(sql);
    } finally {
        client.release();
    }
}

/**
 * Verifies the database is reachable and the expected objects exist.
 * Returns { ok, reachable, version, missing, error }.
 */
export async function checkDatabase() {
    try {
        const version = await queryOne("select version() as version");

        const objects = await query(
            `select table_name
               from information_schema.tables
              where table_schema = 'public'
                and table_name in ('knowledge_bases', 'kb_pages', 'kb_chunks')`
        );
        const present = new Set(objects.map((row) => row.table_name));
        const missing = ["knowledge_bases", "kb_pages", "kb_chunks"].filter(
            (name) => !present.has(name)
        );

        const fn = await queryOne(
            `select 1 as ok
               from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'match_chunks'`
        );
        if (!fn) missing.push("match_chunks()");

        return {
            ok: missing.length === 0,
            reachable: true,
            version: version?.version ?? null,
            missing,
            error: null,
        };
    } catch (error) {
        return {
            ok: false,
            reachable: false,
            version: null,
            missing: [],
            error: error.message,
        };
    }
}

/** Closes the pool. Call on graceful shutdown. */
export async function closePool() {
    await pool.end();
}
