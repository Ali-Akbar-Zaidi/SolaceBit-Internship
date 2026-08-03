import { get_encoding } from "tiktoken";

import { cleanText } from "./cleaner.js";

/**
 * Token-aware text chunking.
 *
 * Chunk sizes are measured in real tokens (cl100k_base) rather than words, so
 * a chunk can never silently exceed the embedding model's context window. Word
 * counting under-estimates badly on code, URLs and CJK text, where a single
 * "word" can be a dozen tokens.
 *
 * Structure is preserved as far as possible: paragraphs are packed whole, and
 * only a paragraph that is itself too large gets split at sentence boundaries.
 * Consecutive chunks share `overlapTokens` of trailing context so a fact
 * spanning a boundary is still retrievable.
 */

export const DEFAULT_CHUNK_TOKENS = Number(process.env.CHUNK_TOKENS) || 512;
export const DEFAULT_OVERLAP_TOKENS = Number(process.env.CHUNK_OVERLAP_TOKENS) || 64;

/**
 * cl100k_base is the BPE used by text-embedding-3 and GPT-4. nomic-embed-text
 * uses a different tokenizer, but cl100k is a close and slightly conservative
 * proxy, so budgeting against it keeps us inside nomic's 8192-token window.
 */
let encoding = null;

function getEncoding() {
    if (!encoding) {
        encoding = get_encoding("cl100k_base");
    }
    return encoding;
}

/** Releases the tokenizer's WASM memory. Call on shutdown. */
export function freeEncoding() {
    if (encoding) {
        encoding.free();
        encoding = null;
    }
}

/** Exact token count for a string. */
export function countTokens(text) {
    if (!text) return 0;
    return getEncoding().encode(text).length;
}

/**
 * Truncates text to at most `maxTokens` tokens, decoding back to a string.
 * Used as a hard safety net before embedding.
 */
export function truncateToTokens(text, maxTokens) {
    const enc = getEncoding();
    const tokens = enc.encode(text);
    if (tokens.length <= maxTokens) return text;
    return new TextDecoder().decode(enc.decode(tokens.slice(0, maxTokens)));
}

/** Splits a paragraph into sentences, keeping terminal punctuation. */
function splitSentences(paragraph) {
    const parts = paragraph.match(/[^.!?]+[.!?]+[\s"')\]]*|[^.!?]+$/g);
    return parts ? parts.map((s) => s.trim()).filter(Boolean) : [paragraph];
}

/**
 * Splits a single oversized sentence on a hard token boundary. Only reached by
 * pathological input such as minified data or a wall of text with no
 * punctuation, but it guarantees no unit ever exceeds maxTokens.
 */
function splitByTokens(text, maxTokens) {
    const enc = getEncoding();
    const tokens = enc.encode(text);
    const decoder = new TextDecoder();
    const pieces = [];
    for (let i = 0; i < tokens.length; i += maxTokens) {
        pieces.push(decoder.decode(enc.decode(tokens.slice(i, i + maxTokens))).trim());
    }
    return pieces.filter(Boolean);
}

/**
 * Breaks text into units (paragraphs, then sentences, then raw token windows)
 * where every unit is guaranteed to fit within maxTokens.
 *
 * Units are kept as granular as the text allows. Pre-packing sentences into
 * near-chunk-sized units would starve the overlap step: if one unit already
 * fills a chunk, there is no smaller tail left to carry into the next one.
 */
function buildUnits(text, maxTokens) {
    const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.replace(/\n/g, " ").trim())
        .filter(Boolean);

    // A unit may be at most this large, so several always fit in one chunk and
    // the overlap tail can be taken at sentence granularity.
    const unitCeiling = Math.max(1, Math.floor(maxTokens / 2));
    const units = [];

    for (const paragraph of paragraphs) {
        if (countTokens(paragraph) <= unitCeiling) {
            units.push(paragraph);
            continue;
        }

        // Oversized paragraph: emit its sentences individually.
        for (const sentence of splitSentences(paragraph)) {
            if (countTokens(sentence) > unitCeiling) {
                units.push(...splitByTokens(sentence, unitCeiling));
            } else {
                units.push(sentence);
            }
        }
    }

    return units;
}

/**
 * Splits cleaned text into overlapping, token-bounded chunks.
 * Returns [{ text, tokenCount }] with every tokenCount <= chunkTokens.
 */
export function chunkText(text, options = {}) {
    const {
        chunkTokens = DEFAULT_CHUNK_TOKENS,
        overlapTokens = DEFAULT_OVERLAP_TOKENS,
    } = options;

    if (overlapTokens >= chunkTokens) {
        throw new Error("overlapTokens must be smaller than chunkTokens");
    }
    if (!text || !text.trim()) return [];

    const units = buildUnits(text, chunkTokens);
    const chunks = [];

    // Units accumulating into the next chunk. The chunk's true size is always
    // measured on the joined text: the "\n" separators are themselves tokens,
    // so summing per-unit counts under-reports and would overflow the ceiling.
    let current = [];

    const sizeOf = (units_) => (units_.length === 0 ? 0 : countTokens(units_.join("\n")));

    for (const unit of units) {
        const candidate = [...current, unit];

        if (current.length > 0 && sizeOf(candidate) > chunkTokens) {
            const body = current.join("\n");
            chunks.push({ text: body, tokenCount: countTokens(body) });

            // Seed the next chunk with the tail of this one so context carries
            // across the boundary. Walk backwards until the overlap budget is
            // spent, never keeping the entire chunk (that would not advance).
            const carried = [];
            for (let i = current.length - 1; i >= 0; i--) {
                if (sizeOf([current[i], ...carried]) > overlapTokens) break;
                carried.unshift(current[i]);
            }
            if (carried.length === current.length) carried.shift();

            current = carried;
        }

        current.push(unit);
    }

    // The final chunk is dropped if it is nothing but carried-over overlap,
    // since that content is already present in the previous chunk.
    if (current.length > 0) {
        const body = current.join("\n");
        const tokens = countTokens(body);
        if (chunks.length === 0 || tokens > overlapTokens) {
            chunks.push({ text: body, tokenCount: tokens });
        }
    }

    return chunks;
}

/**
 * Rejects a chunk that carries no answerable prose.
 *
 * Cleaning removes navigation lines individually, but the fragments left
 * around them ("2nd Edition", a lone appendix label, a chapter preamble) can
 * still combine into a chunk that scores well on topical keywords while
 * containing nothing to quote. Such a chunk crowds real content out of the top
 * results, so it is dropped before embedding.
 */
function hasAnswerableProse(text) {
    const lines = text
        .split("\n")
        .map((line) => line.replace(/^##\s+/, "").trim())
        .filter(Boolean);

    const totalWords = lines.reduce((sum, l) => sum + l.split(/\s+/).length, 0);

    // Short chunks are judged only on their own merits. A brief page can be a
    // legitimate single sentence, and the ratio test below is meaningless when
    // there is barely any text to weigh.
    if (totalWords < 25) {
        return lines.some((line) => /[.!?]["')\]]?$/.test(line));
    }

    // A line reads as prose once it is a reasonable length and terminates like
    // a sentence rather than a link label.
    const proseLines = lines.filter(
        (line) => line.split(/\s+/).length >= 8 && /[.!?]["')\]]?$/.test(line)
    );
    if (proseLines.length === 0) return false;

    // At least a third of the chunk's words should come from those lines,
    // otherwise the chunk is mostly labels with a sentence attached.
    const proseWords = proseLines.reduce((sum, l) => sum + l.split(/\s+/).length, 0);
    if (proseWords / totalWords < 0.34) return false;

    // Reference sites carry book listings, author credits and link menus that
    // survive as short capitalised fragments. They embed well against topical
    // questions but answer nothing, and a model told to quote closely will
    // reproduce them as a list. A chunk is rejected only when such lines
    // outnumber the rest, so prose interleaved with a few labels survives.
    const listish = lines.filter(isListingLine).length;
    return listish / lines.length <= 0.5;
}

/**
 * Detects a bibliography entry, author credit or navigation label.
 *
 * These lines look alike across sites: title case, no sentence punctuation, and
 * no verb doing any work. The verb test is what separates "Jami' al-Sa'adat
 * Muhammad Mahdi Naraqi" from a genuine short sentence.
 */
const COMMON_VERBS =
    /\b(is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|should|may|might|must|says?|said|means?|meant|refers?|includes?|shows?|describes?|explains?|allows?|makes?|made|gives?|gave|takes?|took|uses?|used|provides?|requires?|becomes?|became|remains?|consists?|contains?|occurs?|exists?)\b/i;

function isListingLine(line) {
    const body = line.replace(/^##\s+/, "").trim();
    if (!body) return true;

    const words = body.split(/\s+/);

    // Long lines that end like sentences are prose regardless of casing.
    if (/[.!?]["')\]]?$/.test(body) && words.length >= 8) return false;

    // No verb and no terminal punctuation: a label, not a statement.
    if (!COMMON_VERBS.test(body) && !/[.!?]$/.test(body)) return true;

    // Mostly capitalised words is the signature of a title or a name list.
    const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
    if (words.length >= 3 && capitalised / words.length >= 0.6) return true;

    return false;
}

/**
 * Drops navigation-style lines from the head of a chunk.
 *
 * A chunk can be overwhelmingly good prose yet still open with a stray link
 * label or edition note left behind by cleaning. Those opening lines are what
 * an embedding sees first and what a small model tends to echo, so they are
 * removed once real prose begins. Only the leading run is touched; anything
 * after the first prose line is left intact.
 */
function trimLeadingLabels(text) {
    const lines = text.split("\n");
    let start = 0;

    while (start < lines.length) {
        const line = lines[start].trim();
        const body = line.replace(/^##\s+/, "");

        // Stop at the first line that reads like a sentence.
        const isProse = body.split(/\s+/).length >= 8 && /[.!?]["')\]]?$/.test(body);
        if (isProse) break;

        // Keep a section heading directly above prose: it gives useful context.
        if (line.startsWith("## ")) {
            const next = lines[start + 1]?.trim() ?? "";
            const nextIsProse =
                next.split(/\s+/).length >= 8 && /[.!?]["')\]]?$/.test(next);
            if (nextIsProse) break;
        }

        start++;
    }

    // Every line looked like a label: keep the chunk unchanged rather than
    // returning nothing, since hasAnswerableProse already vouched for it.
    if (start >= lines.length) return text.trim();

    return lines.slice(start).join("\n").trim();
}

/**
 * Removes navigation and bibliography lines from a chunk.
 *
 * `hasAnswerableProse` decides whether a chunk is worth keeping at all; this
 * cleans the survivors. Interior listing lines matter as much as leading ones,
 * because a model instructed to quote closely will happily reproduce a book
 * list sitting between two good paragraphs.
 *
 * A section heading is kept when real prose follows it, since it supplies
 * useful context for the retrieved passage.
 */
function stripListingLines(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    const isProse = (line) => {
        const body = (line ?? "").replace(/^##\s+/, "");
        return body.split(/\s+/).length >= 8 && /[.!?]["')\]]?$/.test(body);
    };

    const kept = lines.filter((line, i) => {
        if (isProse(line)) return true;
        if (line.startsWith("## ") && isProse(lines[i + 1])) return true;
        return !isListingLine(line);
    });

    return kept.join("\n").trim();
}

/**
 * Cleans and chunks a set of scraped pages.
 *
 * Returns [{ pageIndex, chunkIndex, text, tokenCount, source: { url, title } }]
 * ordered by page, then position within the page.
 */
export function buildChunks(pages, options = {}) {
    const chunks = [];

    pages.forEach((page, pageIndex) => {
        const cleaned = cleanText(page.text);
        if (!cleaned) return;

        // chunkIndex must stay contiguous after filtering, because it is part
        // of a unique key in the database.
        let chunkIndex = 0;
        for (const chunk of chunkText(cleaned, options)) {
            if (!hasAnswerableProse(chunk.text)) continue;

            const text = stripListingLines(trimLeadingLabels(chunk.text));
            if (!text) continue;

            // Stripping can leave nothing but residue. A complete sentence is
            // always kept regardless of length, since a single short sentence
            // can itself be the answer; only sub-sentence fragments are cut.
            const isSentence = /[.!?]["')\]]?$/.test(text);
            if (!isSentence && countTokens(text) < 8) continue;

            chunks.push({
                pageIndex,
                chunkIndex: chunkIndex++,
                text,
                tokenCount: countTokens(text),
                source: { url: page.url, title: page.title },
            });
        }
    });

    return chunks;
}
