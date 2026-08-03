import "dotenv/config";

import { embed, OLLAMA_URL, CHAT_MODEL, EMBED_MODEL } from "../src/llm/ollama.js";
import { searchChunks } from "../src/vectorstore/vectorStore.js";
import { buildMessages } from "../src/rag/prompt.js";
import { countTokens, freeEncoding } from "../src/processing/chunker.js";
import { closePool } from "../src/db/client.js";

/**
 * Latency and grounding diagnostic.
 *
 * Reports where a query actually spends its time and whether the prompt fits
 * inside the model's context window. A prompt longer than num_ctx is silently
 * truncated by the server, which would drop retrieved context and leave the
 * model answering from its own knowledge.
 */

const QUESTION = "What is version control?";

function ms(t0) {
    return Number(Date.now() - t0);
}

// --- model context window -----------------------------------------------------
const show = await fetch(`${OLLAMA_URL}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL }),
}).then((r) => r.json());

const trained = show?.model_info
    ? Object.entries(show.model_info).find(([k]) => k.endsWith(".context_length"))?.[1]
    : null;

console.log("=== MODEL ===");
console.log("chat model      :", CHAT_MODEL);
console.log("trained ctx len :", trained ?? "unknown");
console.log("params          :", show?.details?.parameter_size ?? "unknown");
console.log(
    "num_ctx in file :",
    /num_ctx/i.test(show?.parameters || "") ? show.parameters : "not set (server default applies)"
);

// --- embedding latency, cold vs warm -----------------------------------------
console.log("\n=== EMBEDDING LATENCY ===");
let t = Date.now();
await embed(QUESTION);
console.log("first embed (may include model load):", ms(t), "ms");

const warm = [];
for (let i = 0; i < 3; i++) {
    t = Date.now();
    await embed(QUESTION);
    warm.push(ms(t));
}
console.log("warm embeds                        :", warm.join(", "), "ms");

// --- retrieval latency --------------------------------------------------------
console.log("\n=== RETRIEVAL ===");
t = Date.now();
const qVec = await embed(QUESTION);
const embedMs = ms(t);
t = Date.now();
const chunks = await searchChunks(qVec, {});
const searchMs = ms(t);
console.log("embed question :", embedMs, "ms");
console.log("vector search  :", searchMs, "ms");
console.log("chunks         :", chunks.length);
console.log("chunk tokens   :", chunks.map((c) => c.tokenCount).join(", "));

// --- prompt size vs context window -------------------------------------------
const messages = buildMessages(QUESTION, chunks, { siteCount: 11 });
const promptTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0);

console.log("\n=== PROMPT SIZE ===");
console.log("system+user tokens :", promptTokens);
console.log("context chunks     :", chunks.length);
console.log(
    "verdict            :",
    promptTokens > 2048
        ? "EXCEEDS the common 2048 default -> server truncates -> context is lost"
        : "fits within a 2048 window"
);

// --- generation timing from Ollama metadata ----------------------------------
console.log("\n=== GENERATION (server-reported) ===");
t = Date.now();
const gen = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0, num_predict: 200 },
    }),
}).then((r) => r.json());
const totalMs = ms(t);

const toMs = (ns) => (ns ? Math.round(ns / 1e6) : 0);
console.log("wall clock        :", totalMs, "ms");
console.log("load              :", toMs(gen.load_duration), "ms");
console.log(
    "prefill (prompt)  :",
    toMs(gen.prompt_eval_duration),
    "ms for",
    gen.prompt_eval_count,
    "tokens"
);
console.log(
    "generation        :",
    toMs(gen.eval_duration),
    "ms for",
    gen.eval_count,
    "tokens"
);
if (gen.eval_count && gen.eval_duration) {
    console.log(
        "throughput        :",
        (gen.eval_count / (gen.eval_duration / 1e9)).toFixed(1),
        "tok/s"
    );
}
console.log(
    "prompt truncated  :",
    gen.prompt_eval_count < promptTokens * 0.85
        ? `YES - server saw ${gen.prompt_eval_count} of ~${promptTokens} tokens`
        : "no"
);

// --- grounding check ----------------------------------------------------------
const answer = gen.message?.content ?? "";
const contextText = chunks.map((c) => c.text).join(" ").toLowerCase();

const stop = new Set(
    ("the a an and or but if then than that this these those of to in on for with as is are was were be been " +
        "being it its by from at can could will would should may might do does did have has had you your i we " +
        "they he she them their our not no so such also more most other some any each which who whom what when " +
        "where why how all both few many own same too very s t just don now").split(" ")
);

const answerTerms = [
    ...new Set(
        answer
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 3 && !stop.has(w))
    ),
];
const unsupported = answerTerms.filter((w) => !contextText.includes(w));

console.log("\n=== GROUNDING ===");
console.log("answer chars        :", answer.length);
console.log("distinct terms      :", answerTerms.length);
console.log("terms NOT in context:", unsupported.length);
console.log(
    "support ratio       :",
    answerTerms.length
        ? ((answerTerms.length - unsupported.length) / answerTerms.length).toFixed(2)
        : "n/a"
);
if (unsupported.length) {
    console.log("examples            :", unsupported.slice(0, 15).join(", "));
}
console.log("\n--- ANSWER ---");
console.log(answer);

freeEncoding();
await closePool();
