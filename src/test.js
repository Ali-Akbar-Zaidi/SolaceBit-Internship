import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import "dotenv/config";
import { indexWebsite, answerQuestion } from "./rag/pipeline.js";
import { checkOllama } from "./llm/ollama.js";

/**
 * CLI end-to-end test of the whole RAG pipeline (no browser needed):
 *
 *   node src/test.js [url]
 *
 * Crawls the site, builds the knowledge base, then lets you ask
 * questions in the terminal. Type "exit" to quit.
 */

const url = process.argv[2] || "https://nodejs.org/en/learn/getting-started/introduction-to-nodejs";

console.log("\nChecking Ollama...");
const ollama = await checkOllama();
if (!ollama.ok) {
    if (!ollama.reachable) {
        console.error("Ollama is not running. Start it, then try again.");
    } else {
        console.error(`Missing models: ${ollama.missing.join(", ")}. Pull them with "ollama pull <model>".`);
    }
    process.exit(1);
}
console.log(`Ollama ready (chat=${ollama.models.chat}, embeddings=${ollama.models.embed})`);

console.log(`\nIndexing ${url} ...`);
const store = await indexWebsite(url, {
    maxPages: 5,
    onProgress: (update) => {
        if (update.phase === "crawling") {
            console.log(`  crawled ${update.crawled}/${update.total}: ${update.url}`);
        } else if (update.phase === "chunking") {
            console.log(`  split into ${update.chunks} chunks`);
        } else if (update.phase === "embedding") {
            console.log(`  embedded ${update.done}/${update.total} chunks`);
        } else if (update.phase === "done" && update.cached) {
            console.log("  loaded knowledge base from cache");
        }
    },
});
console.log(`\nKnowledge base ready: "${store.meta.siteTitle}" (${store.size} chunks)`);

const rl = readline.createInterface({ input: stdin, output: stdout });
const history = [];

console.log('\nAsk questions about the site (type "exit" to quit):\n');
while (true) {
    const question = (await rl.question("You: ")).trim();
    if (!question) continue;
    if (question.toLowerCase() === "exit") break;

    const { answer, sources } = await answerQuestion(question, store, { history });
    console.log(`\nBot: ${answer}`);
    if (sources.length > 0) {
        console.log(`Sources: ${sources.map((s) => s.url).join(", ")}`);
    }
    console.log("");

    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: answer });
    while (history.length > 6) history.shift();
}

rl.close();
