import { cleanText } from "./cleaner.js";

/**
 * Phase 2b - Text Chunker
 *
 * Splits cleaned page text into overlapping chunks of roughly
 * `chunkSize` words. Overlap means neighbouring chunks share some words,
 * so an idea that straddles a boundary is never lost entirely.
 *
 * Chunks carry their source metadata (page URL + title) so answers
 * can cite where they came from.
 */

function countWords(text) {
    return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Splits one text into overlapping word-window chunks.
 * Paragraph boundaries are respected where possible: paragraphs are packed
 * into a chunk until the size limit, and oversized paragraphs are split
 * by sentence.
 */
export function chunkText(text, options = {}) {
    const { chunkSize = 200, overlap = 40 } = options;

    // Work in paragraph units first so chunks stay coherent.
    const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.replace(/\n/g, " ").trim())
        .filter((p) => p.length > 0);

    // Break any single paragraph longer than chunkSize into sentences.
    const units = [];
    for (const para of paragraphs) {
        if (countWords(para) <= chunkSize) {
            units.push(para);
        } else {
            const sentences = para.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [para];
            let buffer = "";
            for (const sentence of sentences) {
                if (countWords(buffer + sentence) > chunkSize && buffer) {
                    units.push(buffer.trim());
                    buffer = "";
                }
                buffer += sentence;
            }
            if (buffer.trim()) units.push(buffer.trim());
        }
    }

    // Pack units into chunks with overlap.
    const chunks = [];
    let current = [];
    let currentWords = 0;

    for (const unit of units) {
        const unitWords = countWords(unit);

        if (currentWords + unitWords > chunkSize && current.length > 0) {
            chunks.push(current.join("\n"));

            // Start the next chunk with the tail of this one (the overlap).
            const overlapUnits = [];
            let overlapWords = 0;
            for (let i = current.length - 1; i >= 0 && overlapWords < overlap; i--) {
                overlapUnits.unshift(current[i]);
                overlapWords += countWords(current[i]);
            }
            current = overlapUnits;
            currentWords = overlapWords;
        }

        current.push(unit);
        currentWords += unitWords;
    }

    if (current.length > 0) {
        const finalChunk = current.join("\n");
        // Avoid emitting a tiny final chunk that is pure overlap.
        if (chunks.length === 0 || countWords(finalChunk) > overlap) {
            chunks.push(finalChunk);
        }
    }

    return chunks;
}

/**
 * Full Phase 2 for a set of crawled pages:
 * clean each page, chunk it, and attach source metadata.
 *
 * Returns [{ id, text, source: { url, title } }].
 */
export function buildChunks(pages, options = {}) {
    const chunks = [];
    let id = 0;

    for (const page of pages) {
        const cleaned = cleanText(page.text);
        if (!cleaned) continue;

        for (const text of chunkText(cleaned, options)) {
            chunks.push({
                id: id++,
                text,
                source: { url: page.url, title: page.title },
            });
        }
    }

    return chunks;
}
