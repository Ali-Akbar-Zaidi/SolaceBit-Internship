import "dotenv/config";
import { answerQuestion, cleanup } from "../src/rag/pipeline.js";
import { closePool } from "../src/db/client.js";

const tests = [
  { q: "what was the battle of karbala", expect: "refuse" },
  { q: "what was the war of independence", expect: "answer" },
  { q: "who were the sepoys", expect: "answer" },
  { q: "what caused the Indian Rebellion of 1857", expect: "answer" },
];

let fail = 0;
for (const t of tests) {
  const t0 = Date.now();
  const r = await answerQuestion(t.q, {});
  const words = r.answer.split(/\s+/).filter(Boolean).length;
  const stub = !r.refusal && (words < 15 || /:$/.test(r.answer.trim()));
  const ok = t.expect === "refuse" ? r.refusal : (!r.refusal && r.sources.length > 0 && !stub);
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " [" + t.expect + "] " + t.q);
  console.log("      refusal=" + r.refusal + " sources=" + r.sources.length + " words=" + words + " ms=" + (Date.now()-t0) + (stub ? "  <-- STUB" : ""));
  if (!r.refusal) console.log("      " + r.answer.replace(/\s+/g," ").slice(0,230));
  console.log("");
}
console.log(fail === 0 ? "ALL PASSED" : fail + " FAILED");
cleanup(); await closePool();
process.exit(fail ? 1 : 0);
