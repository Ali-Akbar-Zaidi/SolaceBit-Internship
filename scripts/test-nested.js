import { cleanText } from "../src/processing/cleaner.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };

// The real Wikipedia structure that defeated the previous version.
const real = [
"## Historiography",
"Scholars have debated the nature of the rebellion for over a century now.",
"## In popular culture",
"## Films",
"The 1957 film Jhansi Ki Rani depicted the rebellion.",
"## Theatre",
"A play was staged in 1972 about these events.",
"## Literature",
"Indian writer Ruskin Bond's fictional novella A Flight of Pigeons is set around the Indian Rebellion of 1857.",
"It is from this story that the film Junoon was later adapted in 1978 by Shyam Benegal.",
"## Folk music",
"Songs about the rebellion survive in several regions.",
"## See also",
"Indian independence movement",
].join("\n");
const out = cleanText(real);
check("Historiography kept",        out.includes("debated the nature"), JSON.stringify(out));
check("Films subsection dropped",   !out.includes("Jhansi Ki Rani"), JSON.stringify(out));
check("Theatre subsection dropped", !out.includes("play was staged"), JSON.stringify(out));
check("Literature dropped",         !out.includes("Ruskin Bond"), JSON.stringify(out));
check("Folk music dropped",         !out.includes("Songs about"), JSON.stringify(out));
check("See also dropped",           !out.includes("independence movement"), JSON.stringify(out));

// A genuine section following the trivia block must resume.
const resume = ["## In popular culture","## Films","Movie trivia here about the film.","## Consequences","The rebellion led to the dissolution of the East India Company and direct Crown rule."].join("\n");
const r2 = cleanText(resume);
check("real section after trivia resumes", r2.includes("dissolution of the East India Company"), JSON.stringify(r2));
check("trivia before it still dropped",    !r2.includes("Movie trivia"), JSON.stringify(r2));

// "Films" as a standalone top-level section (not inside apparatus) is content.
const standalone = ["## Films","The studio released four films in 1957 that year and each performed well."].join("\n");
check("standalone Films section kept", cleanText(standalone).includes("studio released"), JSON.stringify(cleanText(standalone)));

console.log(fail===0?"\nNESTED TAIL SECTION TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
