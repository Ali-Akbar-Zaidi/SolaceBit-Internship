import "dotenv/config";

import { embed, chat } from "../src/llm/ollama.js";
import { searchChunks } from "../src/vectorstore/vectorStore.js";
import { answerQuestion, cleanup } from "../src/rag/pipeline.js";
import { buildMessages } from "../src/rag/prompt.js";
import { countTokens, freeEncoding } from "../src/processing/chunker.js";
import { listKnowledgeBases } from "../src/vectorstore/vectorStore.js";
import { closePool } from "../src/db/client.js";

/**
 * Measures latency and grounding on whatever corpus is currently indexed.
 *
 * Questions are derived from the stored content, so this works against any
 * site rather than assuming a particular one is present.
 */

const STOP = new Set(
    ("the a an and or but if then than that this these those of to in on for with as is are was were be been being " +
        "it its by from at can could will would should may might do does did have has had you your i we they he she " +
        "them their our not no so such also more most other some any each which who whom what when where why how all " +
        "both few many own same too very just don now about into over under between during before after above below " +
        "only such there here them then they what while whose within without").split(/\s+/)
);

function contentWords(text) {
    return [
        ...new Set(
            text
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter((w) => w.length > 3 && !STOP.has(w))
        ),
    ];
}

/** Fraction of the answer's content words that appear in the context. */
function supportRatio(answer, context) {
    const words = contentWords(answer);
    if (words.length === 0) return 1;
    const haystack = context.toLowerCase();
    const supported = words.filter((w) => haystack.includes(w));
    return supported.length / words.length;
}

const kbs = (await listKnowledgeBases()).filter((k) => k.status === "ready");
if (kbs.length === 0) {
    console.error("No ready knowledge bases. Index a site first.");
    await closePool();
    process.exit(1);
}

console.log("=== CORPUS ===");
for (const kb of kbs) {
    console.log(`  ${kb.site_title}  ${kb.page_count}p ${kb.chunk_count}c  ${kb.site_url}`);
}

// Derive an on-topic question from the corpus itself, plus a control question
// that is certainly absent from any of these sites.
const probe = await searchChunks(await embed(kbs[0].site_title), { topK: 1, minScore: 0 });
const topic = probe[0]?.source.title || kbs[0].site_title;

const questions = [
    { q: `What is ${topic} about?`, expect: "answer" },
    { q: "What is the current price of Bitcoin in US dollars?", expect: "refuse" },
];

console.log("\n=== END TO END ===");
let failures = 0;

for (const { q, expect } of questions) {
    const t0 = Date.now();

    const vec = await embed(q);
    const embedMs = Date.now() - t0;

    const t1 = Date.now();
    const chunks = await searchChunks(vec, {});
    const searchMs = Date.now() - t1;

    const promptTokens = chunks.length
        ? buildMessages(q, chunks).reduce((s, m) => s + countTokens(m.content), 0)
        : 0;

    const t2 = Date.now();
    let firstTokenMs = null;
    const result = await answerQuestion(q, {
        onToken: () => {
            if (firstTokenMs === null) firstTokenMs = Date.now() - t2;
        },
    });
    const totalMs = Date.now() - t0;

    const context = chunks.map((c) => c.text).join(" ");
    const ratio = result.refusal ? 1 : supportRatio(result.answer, context);

    const ok =
        expect === "refuse"
            ? result.refusal
            : !result.refusal && result.sources.length > 0 && ratio >= 0.8;
    if (!ok) failures++;

    console.log(`\n${ok ? "PASS" : "FAIL"} [${expect}] ${q}`);
    console.log(
        `  chunks=${chunks.length} promptTokens=${promptTokens} ` +
        `embed=${embedMs}ms search=${searchMs}ms firstToken=${firstTokenMs ?? "-"}ms total=${totalMs}ms`
    );
    console.log(`  supportRatio=${ratio.toFixed(2)} refusal=${result.refusal}`);
    console.log(`  answer: ${result.answer.replace(/\s+/g, " ").slice(0, 260)}`);

    if (!result.refusal && ratio < 0.8) {
        const unsupported = contentWords(result.answer).filter(
            (w) => !context.toLowerCase().includes(w)
        );
        console.log(`  UNSUPPORTED TERMS: ${unsupported.slice(0, 18).join(", ")}`);
    }
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);

cleanup();
freeEncoding();
await closePool();
process.exit(failures === 0 ? 0 : 1);
