import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { crawlWebsite } from "../scraper/crawler.js";
import { buildChunks } from "../processing/chunker.js";
import { embed, embedBatch, chat } from "../llm/ollama.js";
import { VectorStore } from "../vectorstore/vectorStore.js";
import { buildMessages } from "./prompt.js";

/**
 * Phase 5b - The RAG pipeline
 *
 * Two distinct phases:
 *   1. indexWebsite()   - OFFLINE indexing: crawl -> clean/chunk -> embed -> store
 *   2. answerQuestion() - QUERY time: embed question -> search -> prompt -> generate
 */

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");

/** Stable file name for a site's saved knowledge base. */
function storePathFor(url) {
    const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
    return path.join(DATA_DIR, `kb-${hash}.json`);
}

/**
 * INDEXING PHASE - done once per website.
 *
 * Crawls a handful of pages, cleans and chunks the text, embeds every
 * chunk with nomic-embed-text, and stores everything in a VectorStore.
 *
 * `onProgress(update)` receives { phase, ...details } updates:
 *   { phase: "crawling",  crawled, total, url }
 *   { phase: "chunking",  chunks }
 *   { phase: "embedding", done, total }
 *   { phase: "done",      pages, chunks }
 */
export async function indexWebsite(url, options = {}) {
    const {
        maxPages = 8,
        chunkSize = 200,
        overlap = 40,
        onProgress = () => { },
        useCache = true,
    } = options;

    const savedPath = storePathFor(url);

    // Reuse a previously built knowledge base when available.
    if (useCache && fs.existsSync(savedPath)) {
        const store = VectorStore.load(savedPath);
        if (store.size > 0) {
            onProgress({
                phase: "done",
                pages: store.meta.pages,
                chunks: store.size,
                cached: true,
            });
            return store;
        }
    }

    // 1. Crawl a small number of pages on the site.
    const pages = await crawlWebsite(url, {
        maxPages,
        onProgress: (p) => onProgress({ phase: "crawling", ...p }),
    });

    // 2. Clean the text and split it into overlapping chunks.
    const chunks = buildChunks(pages, { chunkSize, overlap });
    if (chunks.length === 0) {
        throw new Error("No usable text chunks could be built from this site.");
    }
    onProgress({ phase: "chunking", chunks: chunks.length });

    // 3. Embed every chunk (same model that will embed the questions).
    const embeddings = await embedBatch(
        chunks.map((c) => c.text),
        { onProgress: (p) => onProgress({ phase: "embedding", ...p }) }
    );

    // 4. Store vectors + metadata, and persist to disk.
    const store = new VectorStore();
    store.add(chunks, embeddings);
    store.meta = {
        siteUrl: url,
        siteTitle: pages[0].title,
        indexedAt: new Date().toISOString(),
        pages: pages.map((p) => ({ url: p.url, title: p.title })),
    };
    store.save(savedPath);

    onProgress({ phase: "done", pages: store.meta.pages, chunks: store.size });
    return store;
}

/**
 * QUERY PHASE - run for every question.
 *
 * 1. Embed the question (same embedding model as the chunks).
 * 2. Vector-search the store for the most relevant chunks.
 * 3. Build a grounded prompt containing those chunks.
 * 4. Ask the local LLM to answer from that context.
 *
 * Returns { answer, sources: [{ url, title, score }] }.
 */
export async function answerQuestion(question, store, options = {}) {
    const { topK = 3, minScore = 0.4, history = [], onToken = null } = options;

    // 1. Embed the incoming question.
    const questionEmbedding = await embed(question);

    // 2. Retrieve the most similar chunks.
    const retrieved = store.search(questionEmbedding, topK, minScore);

    if (retrieved.length === 0) {
        return {
            answer:
                "I could not find anything related to your query within the pages " +
                "I have built my knowledge base on. Please ask a relevant question.",
            sources: [],
        };
    }

    // 3 + 4. Build the grounded prompt and generate the answer.
    const messages = buildMessages(
        question,
        retrieved,
        store.meta.siteTitle || store.meta.siteUrl || "this website",
        history
    );
    const answer = await chat(messages, { onToken });

    // De-duplicate sources by URL, keeping the best score for each page.
    const sourceMap = new Map();
    for (const chunk of retrieved) {
        const existing = sourceMap.get(chunk.source.url);
        if (!existing || chunk.score > existing.score) {
            sourceMap.set(chunk.source.url, {
                url: chunk.source.url,
                title: chunk.source.title,
                score: Number(chunk.score.toFixed(3)),
            });
        }
    }

    return { answer, sources: [...sourceMap.values()] };
}
