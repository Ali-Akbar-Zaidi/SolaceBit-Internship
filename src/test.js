import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import "dotenv/config";
import { indexWebsite, answerQuestion, listSites, cleanup } from "./rag/pipeline.js";
import { checkOllama } from "./llm/ollama.js";
import { checkDatabase, closePool } from "./db/client.js";

/**
 * CLI end-to-end test of the RAG pipeline.
 *
 *   node src/test.js            - chat against everything already indexed
 *   node src/test.js <url>      - index that site first, then chat
 *
 * Questions are answered from all ready knowledge bases at once.
 */

const url = process.argv[2] || null;

console.log("\nChecking Ollama and database...");
const [ollama, database] = await Promise.all([checkOllama(), checkDatabase()]);

if (!ollama.ok) {
    console.error(
        ollama.reachable
            ? `Missing models: ${ollama.missing.join(", ")}. Pull them with "ollama pull <model>".`
            : "Ollama is not running. Start it, then try again."
    );
    process.exit(1);
}
if (!database.ok) {
    console.error(
        database.reachable
            ? `Database schema incomplete: ${database.missing.join(", ")}. Run "npm run migrate".`
            : `Database unreachable: ${database.error}`
    );
    process.exit(1);
}
console.log(`Ollama ready (chat=${ollama.models.chat}, embeddings=${ollama.models.embed})`);
console.log("Database connected (Supabase pgvector)");

if (url) {
    console.log(`\nIndexing ${url} ...`);
    await indexWebsite(url, {
        maxPages: 6,
        onProgress: (update) => {
            if (update.phase === "cached") console.log("  loaded from cache");
            else if (update.phase === "crawling" && update.crawled)
                console.log(`  crawled ${update.crawled}/${update.total}: ${update.url}`);
            else if (update.phase === "chunking") console.log(`  chunking ${update.pages} pages`);
            else if (update.phase === "embedding")
                console.log(`  embedded ${update.done}/${update.total} chunks`);
            else if (update.phase === "writing") console.log("  writing to Supabase");
            else if (update.phase === "done")
                console.log(`  done: ${update.kb.page_count} pages, ${update.kb.chunk_count} chunks`);
        },
    });
}

const sites = (await listSites()).filter((s) => s.status === "ready");
if (sites.length === 0) {
    console.error('\nNo knowledge bases are ready. Run "npm run seed" or pass a URL.');
    await closePool();
    process.exit(1);
}

console.log(`\nCorpus: ${sites.length} site(s)`);
for (const site of sites) {
    console.log(`  - ${site.site_title} (${site.chunk_count} chunks) ${site.site_url}`);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const history = [];

console.log('\nAsk anything about the indexed sites (type "exit" to quit):\n');
while (true) {
    const question = (await rl.question("You: ")).trim();
    if (!question) continue;
    if (question.toLowerCase() === "exit") break;

    process.stdout.write("\nBot: ");
    const { answer, sources, refusal } = await answerQuestion(question, {
        history,
        onToken: (token) => process.stdout.write(token),
    });
    if (!answer) process.stdout.write("(no answer)");
    console.log("");

    if (sources.length > 0) {
        console.log(
            `Sources: ${sources.map((s) => `${s.title} (${s.score})`).join(" | ")}`
        );
    }
    console.log("");

    // A refusal is not part of the conversation, so it is kept out of history.
    if (!refusal) {
        history.push({ role: "user", content: question });
        history.push({ role: "assistant", content: answer });
        while (history.length > 6) history.shift();
    }
}

rl.close();
cleanup();
await closePool();
