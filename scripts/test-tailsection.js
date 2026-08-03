import { cleanText } from "../src/processing/cleaner.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };

// Tail sections must be dropped with their contents
const page = [
"## Causes",
"The rebellion had various causes, most of the rebel sepoys who were dismissed felt aggrieved by British policy.",
"## In popular culture",
"Indian writer Ruskin Bond's fictional novella A Flight of Pigeons is set around the Indian Rebellion of 1857.",
"The 1880 novel The Steam House by Jules Verne takes place in the rebellion.",
"## External links",
"Wikiquote has quotations related to Indian Rebellion of 1857.",
"Library resources about Indian Rebellion of 1857 Online books",
"## References",
"Seema Alavi, The Sepoys and the Company (Delhi: Oxford University Press, 1998)",
].join("\n");
const out = cleanText(page);
check("causes section kept", out.includes("rebel sepoys who were dismissed"), JSON.stringify(out));
check("popular culture dropped", !out.includes("Ruskin Bond"), JSON.stringify(out));
check("external links dropped", !out.includes("Wikiquote"), JSON.stringify(out));
check("references dropped", !out.includes("Seema Alavi"), JSON.stringify(out));

// A real section AFTER a tail section must resume
const resume = ["## References","Some citation here (Delhi: Oxford University Press, 1998)","## Aftermath","The rebellion led to the dissolution of the East India Company and direct Crown rule over India."].join("\n");
check("real section after tail resumes", cleanText(resume).includes("dissolution of the East India Company"), JSON.stringify(cleanText(resume)));

// Inline citations dropped
check("ISBN line dropped", !cleanText("Text here.\nISBN 978-0-19-563484-2").includes("ISBN"));
check("cite template dropped", !cleanText("Body.\n{{cite book}}: 28- 20- 290- 45-").includes("cite book"));
check("publisher parenthetical dropped", !cleanText("Body text.\nSeema Alavi, The Sepoys and the Company (Delhi: Oxford University Press, 1998)").includes("Oxford University Press"));

// Real prose must survive all of it
const prose = "The rebellion began in Meerut in May 1857 when sepoys refused to use the new cartridges. It spread rapidly across northern India over the following months.";
check("prose intact", cleanText(prose) === prose, JSON.stringify(cleanText(prose)));

// A heading named like a tail section but with a real word attached is content
check("'Causes and effects' kept", cleanText("## Causes and effects\nThe policy of annexation angered many rulers across the subcontinent.").includes("annexation"));

// Dates in real prose must not trip the citation filter
check("date prose kept", cleanText("The war lasted from 1857 to 1859 across northern India.").includes("1857"));

console.log(fail===0?"\nTAIL SECTION TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
