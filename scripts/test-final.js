import "dotenv/config";

import { embed } from "../src/llm/ollama.js";
import { searchChunks, listKnowledgeBases } from "../src/vectorstore/vectorStore.js";
import { closePool } from "../src/db/client.js";
import { freeEncoding } from "../src/processing/chunker.js";

/**
 * Retrieval-only checks against whatever corpus is currently indexed.
 *
 * Skips generation so it stays fast, and derives its on-topic question from the
 * stored content rather than assuming a particular site is present.
 */

const kbs = (await listKnowledgeBases()).filter((k) => k.status === "ready");

if (kbs.length === 0) {
    console.log("No ready knowledge bases; nothing to check.");
    await closePool();
    process.exit(0);
}

console.log(`corpus: ${kbs.length} site(s)`);

// An on-topic probe drawn from the corpus itself.
const seed = kbs[0].site_title.replace(/\s*[-|].*$/, "").trim();

/**
 * This layer is deliberately permissive. Vector search returns the nearest
 * chunks whatever the question, because unrelated text is never orthogonal to
 * a query in embedding space: an off-topic question still scores around 0.42
 * on this corpus. Rejecting it is the job of the lexical relevance gate in
 * answerQuestion, covered by test-relevance.js.
 *
 * What is asserted here is that search behaves sanely: it returns results, it
 * ranks a genuinely on-topic question above an unrelated one, and it respects
 * its token budget.
 */
let failures = 0;
const check = (label, condition, detail = "") => {
    if (condition) {
        console.log(`PASS  ${label}`);
    } else {
        console.log(`FAIL  ${label} ${detail}`);
        failures++;
    }
};

const onTopic = await searchChunks(await embed(seed), {});
const offTopic = await searchChunks(await embed("recipe for chocolate cake"), {});

check("on-topic query returns chunks", onTopic.length > 0);

if (onTopic.length) {
    const sites = [...new Set(onTopic.map((h) => h.source.siteTitle))];
    console.log(
        `      "${seed}" -> ${onTopic.length} chunks, top=${onTopic[0].score.toFixed(3)}, sites: ${sites.join(", ")}`
    );
}

const bestOn = onTopic[0]?.score ?? 0;
const bestOff = offTopic[0]?.score ?? 0;
check(
    "on-topic ranks above off-topic",
    bestOn > bestOff,
    `on=${bestOn.toFixed(3)} off=${bestOff.toFixed(3)}`
);
console.log(`      off-topic best score: ${bestOff.toFixed(3)} (filtered later by relevance gate)`);

const budget = Number(process.env.RETRIEVAL_MAX_TOKENS) || 600;
const used = onTopic.reduce((sum, h) => sum + h.tokenCount, 0);
check(
    "context stays within token budget",
    onTopic.length <= 1 || used <= budget,
    `used=${used} budget=${budget}`
);

const topK = Number(process.env.RETRIEVAL_TOP_K) || 3;
check("respects topK", onTopic.length <= topK, `got=${onTopic.length} topK=${topK}`);

console.log(failures === 0 ? "\nretrieval checks passed" : `\n${failures} failed`);

freeEncoding();
await closePool();
process.exit(failures === 0 ? 0 : 1);
