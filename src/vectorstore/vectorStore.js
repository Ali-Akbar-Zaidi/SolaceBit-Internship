import {
    query,
    queryOne,
    withTransaction,
    toVectorLiteral,
} from "../db/client.js";

/**
 * Supabase-backed vector store.
 *
 * Replaces the previous in-memory + JSON-file store. Embeddings live in
 * Postgres (pgvector) so knowledge bases survive restarts, can hold many
 * websites at once, and are searched with an indexed ANN query instead of a
 * brute-force scan in Node.
 */

/** Creates or returns the knowledge base row for a site, marking it indexing. */
export async function upsertKnowledgeBase({ siteUrl, siteTitle, origin, embedModel }) {
    return queryOne(
        `insert into knowledge_bases (site_url, site_title, origin, embed_model, status)
         values ($1, $2, $3, $4, 'indexing')
         on conflict (site_url) do update
            set site_title  = excluded.site_title,
                origin      = excluded.origin,
                embed_model = excluded.embed_model,
                status      = 'indexing',
                error       = null
         returning *`,
        [siteUrl, siteTitle, origin, embedModel]
    );
}

/** Marks a knowledge base ready and records its final counts. */
export async function markReady(kbId, { pageCount, chunkCount }) {
    return queryOne(
        `update knowledge_bases
            set status      = 'ready',
                page_count  = $2,
                chunk_count = $3,
                indexed_at  = now(),
                error       = null
          where id = $1
          returning *`,
        [kbId, pageCount, chunkCount]
    );
}

/**
 * Recovers knowledge bases left mid-index by a crash or a killed process.
 *
 * The "indexing" state is only meaningful while a job is running: nothing else
 * clears it, and `match_chunks` ignores rows that are not ready, so a stranded
 * row silently disappears from retrieval while still occupying a site slot.
 *
 * A row that still owns chunks is restored to ready, since its previous content
 * is intact. One with no chunks never completed a first index and is marked
 * failed so the user can see why.
 */
export async function recoverStaleIndexing() {
    const restored = await query(
        `update knowledge_bases kb
            set status      = 'ready',
                page_count  = counts.pages,
                chunk_count = counts.chunks
           from (
                select k.id,
                       (select count(*)::int from kb_pages  p where p.kb_id  = k.id) as pages,
                       (select count(*)::int from kb_chunks c where c.kb_id  = k.id) as chunks
                  from knowledge_bases k
                 where k.status = 'indexing'
           ) as counts
          where kb.id = counts.id
            and counts.chunks > 0
          returning kb.site_url`
    );

    const failed = await query(
        `update knowledge_bases
            set status = 'failed',
                error  = 'Indexing was interrupted before any content was stored.'
          where status = 'indexing'
          returning site_url`
    );

    return {
        restored: restored.map((r) => r.site_url),
        failed: failed.map((r) => r.site_url),
    };
}

/** Marks a knowledge base failed so it is excluded from retrieval. */
export async function markFailed(kbId, message) {
    return queryOne(
        `update knowledge_bases set status = 'failed', error = $2 where id = $1 returning *`,
        [kbId, String(message).slice(0, 2000)]
    );
}

/**
 * Replaces all pages and chunks for a knowledge base in one transaction.
 *
 * Writing atomically means a crash mid-index can never leave a knowledge base
 * marked ready while holding a half-written set of chunks. Deleting the old
 * pages cascades to their chunks.
 *
 * `pages`  : [{ url, title, contentHash, text }]
 * `chunks` : [{ pageIndex, chunkIndex, text, tokenCount }]
 * `embeddings` : parallel array to `chunks`
 */
export async function replaceContent(kbId, pages, chunks, embeddings) {
    if (chunks.length !== embeddings.length) {
        throw new Error("chunks and embeddings must have the same length");
    }

    return withTransaction(async (client) => {
        await client.query(`delete from kb_pages where kb_id = $1`, [kbId]);

        // Insert pages, keeping their generated ids in crawl order so chunks
        // can be linked back by pageIndex.
        const pageIds = [];
        for (const page of pages) {
            const { rows } = await client.query(
                `insert into kb_pages (kb_id, url, title, content_hash, char_count, token_count)
                 values ($1, $2, $3, $4, $5, $6)
                 returning id`,
                [
                    kbId,
                    page.url,
                    page.title,
                    page.contentHash,
                    page.text.length,
                    page.tokenCount ?? 0,
                ]
            );
            pageIds.push(rows[0].id);
        }

        // Batch the chunk inserts: one round trip per 100 rows rather than per
        // row, which matters over a pooled connection to a remote database.
        const BATCH = 100;
        for (let start = 0; start < chunks.length; start += BATCH) {
            const slice = chunks.slice(start, start + BATCH);
            const values = [];
            const params = [];

            slice.forEach((chunk, i) => {
                const base = i * 6;
                values.push(
                    `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector)`
                );
                params.push(
                    kbId,
                    pageIds[chunk.pageIndex],
                    chunk.chunkIndex,
                    chunk.text,
                    chunk.tokenCount,
                    toVectorLiteral(embeddings[start + i])
                );
            });

            await client.query(
                `insert into kb_chunks (kb_id, page_id, chunk_index, content, token_count, embedding)
                 values ${values.join(", ")}`,
                params
            );
        }

        return { pages: pageIds.length, chunks: chunks.length };
    });
}

/**
 * Cosine-similarity search across knowledge bases.
 *
 * `kbIds` null or empty searches every ready knowledge base, which is what
 * lets one question be answered from whichever site actually covers it.
 *
 * Two filters are applied in sequence:
 *
 *  1. `minScore` - an absolute floor that rejects a question with no real
 *     match anywhere. It must stay low, because absolute cosine values depend
 *     heavily on the corpus: prose-heavy reference sites commonly peak around
 *     0.45-0.55 while documentation peaks near 0.75. A floor tuned on one
 *     corpus silently blocks every result on another.
 *
 *  2. `relativeCutoff` - keeps only chunks scoring within this fraction of the
 *     best hit. This is what actually separates signal from noise, and it
 *     adapts automatically to whatever the corpus scores.
 *
 * `maxTokens` then caps the total context handed to the model, which is the
 * dominant cost in prompt prefill.
 */
export async function searchChunks(queryEmbedding, options = {}) {
    const {
        topK = Number(process.env.RETRIEVAL_TOP_K) || 4,
        minScore = Number(process.env.RETRIEVAL_MIN_SCORE) || 0.35,
        relativeCutoff = Number(process.env.RETRIEVAL_RELATIVE_CUTOFF) || 0.82,
        maxTokens = Number(process.env.RETRIEVAL_MAX_TOKENS) || 1100,
        kbIds = null,
    } = options;

    // Over-fetch, then narrow locally: the extra rows cost almost nothing on an
    // indexed search but give the relative cutoff something to compare against.
    const rows = await query(
        `select * from match_chunks($1::vector, $2, $3, $4::uuid[])`,
        [
            toVectorLiteral(queryEmbedding),
            Math.max(topK * 3, 12),
            minScore,
            kbIds && kbIds.length ? kbIds : null,
        ]
    );

    if (rows.length === 0) return [];

    const best = Number(rows[0].score);
    const kept = [];
    let tokens = 0;

    for (const row of rows) {
        if (kept.length >= topK) break;

        const score = Number(row.score);
        if (score < best * relativeCutoff) break;

        // Always admit the top chunk, even if it alone exceeds the budget;
        // truncating it later is better than returning nothing.
        if (kept.length > 0 && tokens + row.token_count > maxTokens) continue;

        tokens += row.token_count;
        kept.push({
            id: row.chunk_id,
            kbId: row.kb_id,
            text: row.content,
            tokenCount: row.token_count,
            score,
            source: {
                url: row.page_url,
                title: row.page_title,
                siteTitle: row.site_title,
                siteUrl: row.site_url,
            },
        });
    }

    return kept;
}

/** Lists knowledge bases, newest first. */
export async function listKnowledgeBases() {
    return query(
        `select id, site_url, site_title, origin, page_count, chunk_count,
                status, error, indexed_at, created_at
           from knowledge_bases
          order by created_at desc`
    );
}

/** Returns a single knowledge base by site URL, or null. */
export async function getKnowledgeBaseByUrl(siteUrl) {
    return queryOne(`select * from knowledge_bases where site_url = $1`, [siteUrl]);
}

/** Deletes a knowledge base and everything under it. */
export async function deleteKnowledgeBase(kbId) {
    const row = await queryOne(
        `delete from knowledge_bases where id = $1 returning id`,
        [kbId]
    );
    return Boolean(row);
}

/** Aggregate counts for the ready corpus. */
export async function getStats() {
    return queryOne(
        `select
            (select count(*)::int from knowledge_bases where status = 'ready') as ready_sites,
            (select count(*)::int from knowledge_bases)                        as total_sites,
            (select count(*)::int from kb_pages)                               as pages,
            (select count(*)::int from kb_chunks)                              as chunks`
    );
}

/** Pages belonging to a knowledge base, in crawl order. */
export async function listPages(kbId) {
    return query(
        `select url, title, char_count, token_count, scraped_at
           from kb_pages where kb_id = $1 order by scraped_at asc`,
        [kbId]
    );
}

/**
 * Live row counts for one knowledge base.
 *
 * Used after a failed re-index to decide whether the previous content survived,
 * since the stored page_count/chunk_count columns may be stale at that point.
 */
export async function countChunks(kbId) {
    const row = await queryOne(
        `select count(*)::int as n from kb_chunks where kb_id = $1`,
        [kbId]
    );
    return row?.n ?? 0;
}

export async function countPages(kbId) {
    const row = await queryOne(
        `select count(*)::int as n from kb_pages where kb_id = $1`,
        [kbId]
    );
    return row?.n ?? 0;
}
