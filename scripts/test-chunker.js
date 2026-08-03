import { chunkText, countTokens, buildChunks, freeEncoding, truncateToTokens } from "../src/processing/chunker.js";

let failures = 0;
const check = (name, cond, extra="") => { if (cond) console.log("PASS", name); else { console.log("FAIL", name, extra); failures++; } };

// 1. Long prose respects the token ceiling
const para = "The quick brown fox jumps over the lazy dog. ".repeat(200);
const c1 = chunkText(para, { chunkTokens: 100, overlapTokens: 20 });
check("chunks produced", c1.length > 1, `got ${c1.length}`);
check("no chunk exceeds limit", c1.every(c => c.tokenCount <= 100), JSON.stringify(c1.map(c=>c.tokenCount)));
check("reported tokenCount accurate", c1.every(c => c.tokenCount === countTokens(c.text)));

// 2. Overlap actually carries context
const numbered = Array.from({length:120},(_,i)=>`Sentence number ${i} describes topic ${i}.`).join(" ");
const c2 = chunkText(numbered, { chunkTokens: 120, overlapTokens: 30 });
let overlapped = 0;
for (let i=1;i<c2.length;i++){ const prevTail=c2[i-1].text.slice(-60); if (c2[i].text.includes(prevTail.trim().split(" ").slice(-4).join(" "))) overlapped++; }
check("consecutive chunks overlap", overlapped > 0, `${overlapped}/${c2.length-1}`);

// 3. No-punctuation wall of text still bounded
const wall = "token ".repeat(5000);
const c3 = chunkText(wall, { chunkTokens: 128, overlapTokens: 16 });
check("wall-of-text bounded", c3.every(c => c.tokenCount <= 128), JSON.stringify(c3.slice(0,5).map(c=>c.tokenCount)));

// 4. CJK / dense-token text bounded (word counting would fail here)
const cjk = "这是一个测试句子用于验证分词器的准确性。".repeat(300);
const c4 = chunkText(cjk, { chunkTokens: 150, overlapTokens: 25 });
check("CJK bounded", c4.every(c => c.tokenCount <= 150), JSON.stringify(c4.slice(0,5).map(c=>c.tokenCount)));

// 5. Edge cases
check("empty -> []", chunkText("", {}).length === 0);
check("whitespace -> []", chunkText("   \n\n  ", {}).length === 0);
const tiny = chunkText("Short.", { chunkTokens: 512, overlapTokens: 64 });
check("tiny text kept", tiny.length === 1 && tiny[0].text === "Short.");
check("overlap>=chunk throws", (()=>{ try { chunkText("x",{chunkTokens:10,overlapTokens:10}); return false;} catch { return true;} })());

// 6. Termination guarantee - no infinite loop when overlap is large
const c6 = chunkText(numbered, { chunkTokens: 100, overlapTokens: 95 });
check("large overlap terminates and advances", c6.length > 0 && c6.length < 500, `got ${c6.length}`);

// 7. truncateToTokens
check("truncate works", countTokens(truncateToTokens(para, 50)) <= 50);

// 8. buildChunks metadata
const bc = buildChunks([
  { url: "https://a.test/1", title: "A", text: para },
  { url: "https://b.test/2", title: "B", text: "Hello world paragraph here." },
], { chunkTokens: 100, overlapTokens: 20 });
check("buildChunks tags sources", bc.every(c => c.source.url && c.source.title));
check("buildChunks indexes per page", bc.filter(c=>c.pageIndex===0).every((c,i)=>c.chunkIndex===i));
check("buildChunks covers both pages", new Set(bc.map(c=>c.pageIndex)).size === 2);

freeEncoding();
console.log(failures === 0 ? "\nALL CHUNKER TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
