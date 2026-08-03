import { spawnSync } from "node:child_process";

import "dotenv/config";

/**
 * Test runner for `npm test`.
 *
 * Unit suites run first and need nothing external. Integration suites need
 * Ollama, Supabase and an indexed corpus, so they are skipped with a clear
 * message rather than reported as failures when those are unavailable.
 */

const UNIT = [
    ["chunker", "scripts/test-chunker.js"],
    ["chunk filter", "scripts/test-chunkfilter.js"],
    ["cleaner", "scripts/test-cleaner.js"],
    ["listing filter", "scripts/test-listing.js"],
    ["boilerplate filter", "scripts/test-boilerplate.js"],
    ["crawler link filter", "scripts/test-crawler.js"],
    ["disambiguation filter", "scripts/test-disambig.js"],
    ["tail section filter", "scripts/test-tailsection.js"],
    ["nested tail sections", "scripts/test-nested.js"],
];

const INTEGRATION = [
    ["retrieval + guardrail", "scripts/test-final.js"],
    ["relevance gate", "scripts/test-relevance.js"],
    ["answer length + follow-ups", "scripts/test-length.js"],
    ["reported failures", "scripts/test-screenshot.js"],
];

function run(label, file) {
    process.stdout.write(`\n--- ${label} ---\n`);
    const result = spawnSync(process.execPath, [file], { stdio: "inherit" });
    return result.status === 0;
}

let failed = 0;

for (const [label, file] of UNIT) {
    if (!run(label, file)) failed++;
}

// Integration tests only make sense against a live stack.
const { checkOllama } = await import("../src/llm/ollama.js");
const { checkDatabase, closePool } = await import("../src/db/client.js");
const [ollama, database] = await Promise.all([checkOllama(), checkDatabase()]);

if (ollama.ok && database.ok) {
    for (const [label, file] of INTEGRATION) {
        if (!run(label, file)) failed++;
    }
} else {
    const reason = !ollama.ok
        ? "Ollama unavailable or models missing"
        : `database not ready (${database.error || database.missing.join(", ")})`;
    console.log(`\n--- integration ---\nskipped: ${reason}`);
}

await closePool().catch(() => { });

console.log(failed === 0 ? "\nALL SUITES PASSED" : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
