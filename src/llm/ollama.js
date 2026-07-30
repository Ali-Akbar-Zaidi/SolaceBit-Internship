/**
 * Ollama client
 *
 * Everything that talks to the locally running Ollama server lives here:
 * - embed()        -> nomic-embed-text  (Phase 3, embeddings)
 * - chat()         -> llama3            (Phase 5, answer generation)
 * - checkOllama()  -> health check used by the server / UI
 *
 * Uses Node's built-in fetch, exactly the API-call machinery from the
 * learning primer: POST request, JSON body, await the response.
 */

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
export const CHAT_MODEL = process.env.CHAT_MODEL || "llama3";

/**
 * Embeds a single piece of text. Returns the embedding vector
 * (an array of numbers).
 */
export async function embed(text) {
    const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text, keep_alive: "15m" }),
    });

    if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error("Ollama returned an empty embedding");
    }
    return data.embedding;
}

/**
 * Embeds many texts with limited concurrency (Promise.all in batches),
 * so 100 chunks don't fire 100 simultaneous requests.
 * Calls onProgress({ done, total }) after each batch.
 */
export async function embedBatch(texts, options = {}) {
    const { concurrency = 4, onProgress = () => { } } = options;
    const embeddings = new Array(texts.length);

    for (let i = 0; i < texts.length; i += concurrency) {
        const batch = texts.slice(i, i + concurrency);
        const results = await Promise.all(batch.map((text) => embed(text)));
        results.forEach((vector, j) => {
            embeddings[i + j] = vector;
        });
        onProgress({ done: Math.min(i + concurrency, texts.length), total: texts.length });
    }

    return embeddings;
}

/**
 * Sends a chat conversation to the LLM and returns its reply text.
 * `messages` is an array of { role: "system"|"user"|"assistant", content }.
 *
 * The response is streamed and accumulated. Streaming matters on slower
 * machines: with stream:false the HTTP headers only arrive when generation
 * finishes, and Node's fetch aborts if headers take longer than 5 minutes.
 * With streaming, data flows immediately, so long generations are safe.
 */
export async function chat(messages, options = {}) {
    const { temperature = 0.2, onToken = null } = options;

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: CHAT_MODEL,
            messages,
            stream: true,
            keep_alive: "30m", // keep the model loaded between questions
            options: {
                temperature,
                num_predict: 400, // cap answer length so replies stay snappy
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Chat request failed with status ${response.status}`);
    }

    // Ollama streams newline-delimited JSON objects; accumulate the pieces
    // and forward each token to onToken (used for live streaming to the UI).
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    const handleLine = (line) => {
        if (!line.trim()) return;
        const data = JSON.parse(line);
        if (data.error) throw new Error(data.error);
        const piece = data.message?.content ?? "";
        if (piece) {
            text += piece;
            if (onToken) onToken(piece);
        }
    };

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep any incomplete trailing line
        for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    return text.trim();
}

/**
 * Simple one-shot prompt helper (kept for CLI tests / the primer's askLLM).
 */
export async function askLLM(prompt) {
    return chat([{ role: "user", content: prompt }]);
}

/**
 * Checks that Ollama is reachable and that both required models are pulled.
 * Returns { ok, reachable, models: { chat, embed }, missing: [...] }.
 */
export async function checkOllama() {
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

        return {
            ok: missing.length === 0,
            reachable: true,
            models: { chat: CHAT_MODEL, embed: EMBED_MODEL },
            missing,
        };
    } catch {
        return {
            ok: false,
            reachable: false,
            models: { chat: CHAT_MODEL, embed: EMBED_MODEL },
            missing: [CHAT_MODEL, EMBED_MODEL],
        };
    }
}
