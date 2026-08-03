import { buildChunks, freeEncoding } from "../src/processing/chunker.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };
const bc = (text) => buildChunks([{url:"u",title:"t",text}], {chunkTokens:220, overlapTokens:40});

// Bibliography / nav listing must be rejected
const biblio = ["Jami al-Sa\x27adat The Collector of Felicities","Muhammad Mahdi Naraqi","How Can We Prove That Allah Is Real?","Prophethood and Imamate","God and His Attributes","Comparative Religion"].join("\n\n");
check("bibliography rejected", bc(biblio).length===0, JSON.stringify(bc(biblio).map(c=>c.text.slice(0,60))));

// Real prose must survive untouched
const prose = "Divine command theory holds that an action is morally right because God commands it. Critics argue this makes morality arbitrary, since God could in principle command cruelty. Defenders reply that God\x27s nature is essentially good, so such commands are impossible.";
const pc = bc(prose);
check("prose kept", pc.length>0 && pc[0].text.includes("Divine command theory"), JSON.stringify(pc.map(c=>c.text.slice(0,50))));

// Heading above prose is preserved
const withHead = "## The Nature of Divine Command\nDivine command theory holds that an action is morally right because God commands it, and this view has been debated for centuries by theologians.";
check("heading above prose kept", bc(withHead)[0]?.text.includes("## The Nature"), JSON.stringify(bc(withHead)[0]?.text.slice(0,80)));

// Interior listing removed but surrounding prose kept
const mixed = "Divine command theory holds that an action is morally right because God commands it, a view debated for centuries.\n\nJami al-Sa\x27adat The Collector of Felicities\n\nMuhammad Mahdi Naraqi\n\nCritics argue this makes morality arbitrary, since God could in principle command any cruelty at all.";
const mc = bc(mixed);
const joined = mc.map(c=>c.text).join(" ");
check("interior listing stripped", !joined.includes("Naraqi"), JSON.stringify(joined.slice(0,200)));
check("surrounding prose intact", joined.includes("Divine command theory") && joined.includes("Critics argue"));

// Short legitimate sentence survives
const short = "God is described as having prescribed mercy upon Himself.";
check("short sentence kept", bc(short).length>0, JSON.stringify(bc(short).map(c=>c.text)));

freeEncoding();
console.log(fail===0?"\nLISTING FILTER TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
