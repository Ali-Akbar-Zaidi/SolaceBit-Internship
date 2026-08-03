import { resolveLink, isDisambiguationPage } from "../src/scraper/crawler.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };

const o="https://en.wikipedia.org", c="https://en.wikipedia.org/wiki/Indian_Rebellion_of_1857", s="/wiki/Indian_Rebellion_of_1857";
const R=(h)=>resolveLink(h,c,o,s);

console.log("=== URL FILTER ===");
check("(disambiguation) rejected", R("/wiki/Sepoy_Mutiny_(disambiguation)")===null, String(R("/wiki/Sepoy_Mutiny_(disambiguation)")));
check("url-encoded disambig rejected", R("/wiki/Indian_War_%28disambiguation%29")===null, String(R("/wiki/Indian_War_%28disambiguation%29")));
check("real article kept", R("/wiki/Sepoy")!==null);

console.log("\n=== CONTENT FILTER ===");
check("title marker", isDisambiguationPage({title:"Sepoy Mutiny (disambiguation) - Wikipedia", text:"short"}));
check("footer marker", isDisambiguationPage({title:"The Indian War of Independence", text:"The Indian War of Independence may refer to Indian Rebellion of 1857. This disambiguation page lists articles associated with the title."}));
check("topics-referred marker", isDisambiguationPage({title:"X", text:"Some list here. Topics referred to by the same term"}));
check("may refer to + short", isDisambiguationPage({title:"The Indian War of Independence", text:"From Wikipedia. The Indian War of Independence may refer to Indian Rebellion of 1857, rebellion in India against British rule sometimes termed the First War of Indian Independence. India in World War II, the forces of the Azad Hind."}));

// Real articles must survive
const realArticle = { title:"Indian Rebellion of 1857 - Wikipedia", text:"The Indian Rebellion of 1857 was a major uprising in India against the rule of the British East India Company. ".repeat(60) };
check("long real article kept", !isDisambiguationPage(realArticle), "len="+realArticle.text.length);
check("article mentioning phrase kept", !isDisambiguationPage({title:"Mutiny", text:("The term mutiny may refer to different acts depending on jurisdiction. ".repeat(90))}), "long article using the phrase");

console.log(fail===0?"\nDISAMBIGUATION TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
