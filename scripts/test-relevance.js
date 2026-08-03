import "dotenv/config";
import { answerQuestion, cleanup } from "../src/rag/pipeline.js";
import { closePool } from "../src/db/client.js";

const cases = [
  // must REFUSE
  { q: "what was the war of lalalala land", expect: "refuse" },
  { q: "what is the flibbertigibbet protocol", expect: "refuse" },
  { q: "what is the current price of Bitcoin in US dollars", expect: "refuse" },
  { q: "give me a recipe for chocolate cake", expect: "refuse" },
  { q: "who won the 2026 World Cup", expect: "refuse" },
  // must ANSWER
  { q: "what was the Indian Rebellion of 1857", expect: "answer" },
  { q: "who were the sepoys", expect: "answer" },
  { q: "what caused the rebellion against the East India Company", expect: "answer" },
];

let fail = 0;
for (const c of cases) {
  const r = await answerQuestion(c.q, {});
  const ok = c.expect === "refuse" ? r.refusal : (!r.refusal && r.sources.length > 0);
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " [" + c.expect + "] " + c.q);
  console.log("      refusal=" + r.refusal + " sources=" + r.sources.length + " :: " + r.answer.replace(/\s+/g," ").slice(0,110));
}
console.log("\n" + (cases.length - fail) + "/" + cases.length + " passed");
cleanup(); await closePool();
process.exit(fail ? 1 : 0);
