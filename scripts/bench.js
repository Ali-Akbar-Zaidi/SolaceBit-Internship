import "dotenv/config";
import os from "node:os";

import { OLLAMA_URL, CHAT_MODEL } from "../src/llm/ollama.js";
import { countTokens, freeEncoding } from "../src/processing/chunker.js";

/**
 * Benchmarks Ollama prefill and generation on this machine.
 *
 * Prompt prefill dominates perceived latency in RAG: every retrieved token must
 * be processed before the first answer token appears. This measures how prefill
 * scales with prompt size and thread count so the retrieval budget can be set
 * from data instead of guesswork.
 */

const SENTENCE =
    "The system records changes to a set of files over time so that specific " +
    "versions can be recalled later and compared against one another. ";

/** Builds prose of approximately `target` tokens. */
function promptOf(target) {
    let text = "";
    while (countTokens(text) < target) text += SENTENCE;
    return text;
}

async function measure({ promptText, numThread, numCtx }) {
    const options = { temperature: 0, num_predict: 24, num_ctx: numCtx };
    if (numThread) options.num_thread = numThread;

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: CHAT_MODEL,
            messages: [
                { role: "system", content: "Answer from the passage only." },
                { role: "user", content: `${promptText}\n\nQuestion: what is recorded?` },
            ],
            stream: false,
            keep_alive: "30m",
            options,
        }),
    });

    const d = await res.json();
    if (d.error) throw new Error(d.error);

    const prefillTps = d.prompt_eval_duration
        ? d.prompt_eval_count / (d.prompt_eval_duration / 1e9)
        : 0;
    const evalTps = d.eval_duration ? d.eval_count / (d.eval_duration / 1e9) : 0;

    return {
        promptTokens: d.prompt_eval_count,
        prefillMs: Math.round(d.prompt_eval_duration / 1e6),
        prefillTps,
        evalTps,
        firstTokenMs: Math.round((d.load_duration + d.prompt_eval_duration) / 1e6),
    };
}

const cpu = os.cpus();
console.log("cpu   :", cpu.length, "logical /", cpu[0].model.trim());
console.log("model :", CHAT_MODEL);

// Warm the model so the first measurement is not distorted by loading.
await measure({ promptText: promptOf(64), numThread: null, numCtx: 2048 });

console.log("\n=== THREAD COUNT (prompt ~1300 tokens, num_ctx 2560) ===");
const p1300 = promptOf(1300);
for (const numThread of [null, 4, 6, 8, 12]) {
    try {
        const r = await measure({ promptText: p1300, numThread, numCtx: 2560 });
        console.log(
            `  num_thread=${String(numThread ?? "default").padEnd(7)} ` +
            `prefill ${String(r.prefillMs).padStart(6)}ms  ${r.prefillTps.toFixed(0).padStart(4)} tok/s  ` +
            `gen ${r.evalTps.toFixed(1).padStart(5)} tok/s  firstToken ~${r.firstTokenMs}ms`
        );
    } catch (error) {
        console.log(`  num_thread=${numThread}: ${error.message}`);
    }
}

console.log("\n=== PROMPT SIZE (default threads, num_ctx 2560) ===");
for (const target of [300, 600, 900, 1300, 1800]) {
    const r = await measure({ promptText: promptOf(target), numThread: null, numCtx: 2560 });
    console.log(
        `  ~${String(target).padStart(4)} tok -> actual ${String(r.promptTokens).padStart(4)}  ` +
        `prefill ${String(r.prefillMs).padStart(6)}ms  ${r.prefillTps.toFixed(0).padStart(4)} tok/s  ` +
        `firstToken ~${r.firstTokenMs}ms`
    );
}

console.log("\n=== CONTEXT WINDOW (prompt ~900 tokens) ===");
const p900 = promptOf(900);
for (const numCtx of [1024, 2048, 2560, 4096]) {
    const r = await measure({ promptText: p900, numThread: null, numCtx });
    const truncated = r.promptTokens < countTokens(p900) * 0.85;
    console.log(
        `  num_ctx=${String(numCtx).padStart(5)}  saw ${String(r.promptTokens).padStart(4)} tokens  ` +
        `prefill ${String(r.prefillMs).padStart(6)}ms  ${truncated ? "TRUNCATED" : "intact"}`
    );
}

freeEncoding();
