import fs from "node:fs";
import path from "node:path";

/**
 * Phase 4 - Vector Store + Similarity Search
 *
 * A simple in-memory vector store with brute-force cosine similarity
 * search. Perfectly adequate for a small crawl (tens to a few thousand
 * chunks); a dedicated vector database only becomes necessary at scale.
 *
 * Supports saving/loading to a JSON file so an indexed site can be
 * reused without re-crawling and re-embedding.
 */

/**
 * Cosine similarity between two vectors:
 * dot product divided by the product of the magnitudes.
 * 1.0 = same direction (same meaning), 0 = unrelated, -1 = opposite.
 */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        throw new Error("Cannot compare vectors of different lengths");
    }
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denominator = Math.sqrt(magA) * Math.sqrt(magB);
    return denominator === 0 ? 0 : dot / denominator;
}

export class VectorStore {
    constructor() {
        this.entries = []; // [{ id, text, embedding, source: { url, title } }]
        this.meta = {};    // { siteUrl, siteTitle, indexedAt, pages }
    }

    get size() {
        return this.entries.length;
    }

    /**
     * Adds chunks with their embeddings.
     * `chunks` and `embeddings` must be parallel arrays.
     */
    add(chunks, embeddings) {
        if (chunks.length !== embeddings.length) {
            throw new Error("chunks and embeddings must have the same length");
        }
        for (let i = 0; i < chunks.length; i++) {
            this.entries.push({ ...chunks[i], embedding: embeddings[i] });
        }
    }

    /**
     * Brute-force nearest-neighbour search: compares the query embedding
     * against every stored embedding, sorts by similarity, keeps the top K.
     * `minScore` filters out chunks that aren't actually related.
     */
    search(queryEmbedding, topK = 4, minScore = 0.3) {
        return this.entries
            .map((entry) => ({
                id: entry.id,
                text: entry.text,
                source: entry.source,
                score: cosineSimilarity(queryEmbedding, entry.embedding),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .filter((result) => result.score >= minScore);
    }

    clear() {
        this.entries = [];
        this.meta = {};
    }

    /** Persists the store (entries + metadata) to a JSON file. */
    save(filePath) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
            filePath,
            JSON.stringify({ meta: this.meta, entries: this.entries })
        );
    }

    /** Loads a previously saved store. Returns the store for chaining. */
    static load(filePath) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const store = new VectorStore();
        store.meta = data.meta || {};
        store.entries = data.entries || [];
        return store;
    }
}
