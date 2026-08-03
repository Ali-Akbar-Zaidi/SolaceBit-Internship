import { truncateToTokens } from "../processing/chunker.js";

/**
 * Ollama client: embeddings and chat completion.
 */

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
export const CHAT_MODEL = process.env.CHAT_MODEL || "llama3.2:1b";

// nomic-embed-text accepts 8192 tokens. Chunks are far smaller, but a hard cap
// here stops a pathological input from being silently truncated by the server.
const MAX_EMBED_TOKENS = 8000;

/**
 * L2-normalises a vector.
 *
 * pgvector's cosine operator normalises internally, but storing unit vectors
 * keeps the stored data consistent and makes the `<=>` distance directly
 * comparable to a plain dot product.
 */
export function normalize(vector) {
    let sumSquares = 0;
    for (const value of vector) sumSquares += value * value;
    const magnitude = Math.sqrt(sumSquares);
    if (magnitude === 0) {
        throw new Error("Cannot normalise a zero-magnitude embedding");
    }
    return vector.map((value) => value / magnitude);
}

/** Embeds one string and returns a unit vector. */
export async function embed(text) {
    const input = truncateToTokens(text, MAX_EMBED_TOKENS);

    const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: input, keep_alive: "15m" }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
            `Embedding request failed (${response.status}) ${detail.slice(0, 200)}`
        );
    }

    const data = await response.json();
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error("Ollama returned an empty embedding");
    }
    return normalize(data.embedding);
}

/**
 * Embeds many strings with bounded concurrency and retries.
 *
 * A single transient failure part-way through a large crawl would otherwise
 * discard all prior work, so each item is retried before giving up.
 */
export async function embedBatch(texts, options = {}) {
    const { concurrency = 4, retries = 2, onProgress = () => { } } = options;

    const embeddings = new Array(texts.length);
    let completed = 0;

    for (let start = 0; start < texts.length; start += concurrency) {
        const slice = texts.slice(start, start + concurrency);

        await Promise.all(
            slice.map(async (text, offset) => {
                let lastError;
                for (let attempt = 0; attempt <= retries; attempt++) {
                    try {
                        embeddings[start + offset] = await embed(text);
                        return;
                    } catch (error) {
                        lastError = error;
                        if (attempt < retries) {
                            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                        }
                    }
                }
                throw new Error(
                    `Failed to embed chunk ${start + offset} after ${retries + 1} attempts: ${lastError.message}`
                );
            })
        );

        completed += slice.length;
        onProgress({ done: completed, total: texts.length });
    }

    return embeddings;
}

/**
 * Streaming chat completion. `onToken` receives text as it is produced so the
 * UI can render immediately instead of waiting for the full answer.
 */
export async function chat(messages, options = {}) {
    const {
        // Zero temperature: the answer must be a faithful extract from the
        // context, and sampling only invites the model to embellish it.
        temperature = 0,
        numPredict = Number(process.env.ANSWER_MAX_TOKENS) || 180,
        numCtx = Number(process.env.OLLAMA_NUM_CTX) || 2560,
        stop = null,
        onToken = null,
    } = options;

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: CHAT_MODEL,
            messages,
            stream: true,
            keep_alive: "30m",
            options: {
                temperature,
                num_predict: numPredict,
                // Explicit window. Left unset, Ollama applies a small default
                // and silently drops the front of an oversized prompt, taking
                // the retrieved context with it.
                num_ctx: numCtx,
                // Stop the model repeating itself instead of finishing early.
                repeat_penalty: 1.15,
                ...(stop && stop.length ? { stop } : {}),
            },
        }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Chat request failed (${response.status}) ${detail.slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.trim()) continue;
            let data;
            try {
                data = JSON.parse(line);
            } catch {
                continue;
            }
            if (data.error) throw new Error(data.error);
            const piece = data.message?.content ?? "";
            if (piece) {
                text += piece;
                if (onToken) onToken(piece);
            }
        }
    }

    return text.trim();
}

/** Verifies Ollama is reachable and the required models are pulled. */
export async function checkOllama() {
    const models = { chat: CHAT_MODEL, embed: EMBED_MODEL };
    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        if (!response.ok) throw new Error(`status ${response.status}`);

        const data = await response.json();
        const names = (data.models || []).map((m) => m.name);
        const has = (wanted) =>
            names.some((name) => name === wanted || name.startsWith(`${wanted}:`));

        const missing = [];
        if (!has(CHAT_MODEL)) missing.push(CHAT_MODEL);
        if (!has(EMBED_MODEL)) missing.push(EMBED_MODEL);

        return { ok: missing.length === 0, reachable: true, models, missing };
    } catch {
        return {
            ok: false,
            reachable: false,
            models,
            missing: [CHAT_MODEL, EMBED_MODEL],
        };
    }
}
