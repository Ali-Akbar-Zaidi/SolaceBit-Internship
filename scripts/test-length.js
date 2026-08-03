import "dotenv/config";
import { answerQuestion, wantsLongAnswer, cleanup } from "../src/rag/pipeline.js";
import { closePool } from "../src/db/client.js";

let fail = 0;
const check = (n, c, e="") => { if (c) console.log("PASS " + n); else { console.log("FAIL " + n + " " + e); fail++; } };

console.log("=== LENGTH DETECTION (pure function) ===");
for (const [q, want] of [
  ["write a full essay on the war of independence", true],
  ["write a full essay on this", true],
  ["elaborate on this topic more", true],
  ["explain in detail the causes", true],
  ["tell me much more about the rebellion", true],
  ["give me a comprehensive overview", true],
  ["what was the Indian Rebellion of 1857", false],
  ["who were the sepoys", false],
]) check(`wantsLong(${want}) :: ${q}`, wantsLongAnswer(q) === want);

console.log("\n=== PREVIOUSLY REFUSED PROMPTS (must now answer) ===");
const history = [
  { role: "user", content: "what was the Indian War of Independence" },
  { role: "assistant", content: "The Indian War of Independence may refer to the Indian Rebellion of 1857." },
];

for (const q of [
  "write a full essay on the war of independence",
  "elaborate on this topic more",
]) {
  const t0 = Date.now();
  const r = await answerQuestion(q, { history });
  const words = r.answer.split(/\s+/).filter(Boolean).length;
  check(`answered :: ${q}`, !r.refusal && r.sources.length > 0, `refusal=${r.refusal}`);
  console.log(`      words=${words} sources=${r.sources.length} ms=${Date.now()-t0}`);
  console.log(`      ${r.answer.replace(/\s+/g," ").slice(0,200)}...`);
}

console.log("\n=== FOLLOW-UP WITH NO SUBJECT (history resolves it) ===");
const r2 = await answerQuestion("elaborate more", { history });
check("bare follow-up answered via history", !r2.refusal, `refusal=${r2.refusal}`);
console.log(`      ${r2.answer.replace(/\s+/g," ").slice(0,160)}...`);

console.log("\n=== GUARDRAIL STILL HOLDS ===");
for (const q of ["write a full essay on chocolate cake recipes", "what is the flibbertigibbet protocol"]) {
  const r = await answerQuestion(q, {});
  check(`refused :: ${q}`, r.refusal, `refusal=${r.refusal}`);
}

console.log(fail === 0 ? "\nALL PASSED" : `\n${fail} FAILED`);
cleanup(); await closePool();
process.exit(fail ? 1 : 0);
