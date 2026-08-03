import { buildChunks, freeEncoding } from "../src/processing/chunker.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };

// Navigation-only page must yield no chunks
const nav = { url:"u", title:"t", text:["A1.4 Git in IntelliJ / PyCharm / WebStorm","2nd Edition","1.1 About Version Control","1.2 A Short History of Git","Summary"].join("\n\n") };
check("nav-only page yields no chunks", buildChunks([nav],{chunkTokens:512,overlapTokens:64}).length===0);

// Real prose must survive
const prose = { url:"u", title:"t", text:"## About Version Control\n\nVersion control is a system that records changes to a file or set of files over time so that you can recall specific versions later.\n\nFor the examples in this book you will use software source code as the files being version controlled, though in reality you can do this with nearly any type of file on a computer." };
const pc = buildChunks([prose],{chunkTokens:512,overlapTokens:64});
check("prose page kept", pc.length>0 && pc[0].text.includes("records changes"), JSON.stringify(pc.map(c=>c.text.slice(0,60))));

// chunkIndex must stay contiguous after filtering
const mixed = { url:"u", title:"t", text:["1.1 Nav Label","Version control is a system that records changes to files over time so that you can recall specific versions later on demand.","1.2 Another Label","Centralized version control systems have a single server that contains all the versioned files and many clients that check out files."].join("\n\n") };
const mc = buildChunks([mixed],{chunkTokens:40,overlapTokens:8});
check("chunkIndex contiguous", mc.every((c,i)=>c.chunkIndex===i), JSON.stringify(mc.map(c=>c.chunkIndex)));

freeEncoding();
console.log(fail===0?"\nCHUNK FILTER TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
