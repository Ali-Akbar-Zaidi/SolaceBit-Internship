import { resolveLink } from "../src/scraper/crawler.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };

const origin = "https://en.wikipedia.org";
const cur = "https://en.wikipedia.org/wiki/Indian_Rebellion_of_1857";
const start = "/wiki/Indian_Rebellion_of_1857";
const R = (href) => resolveLink(href, cur, origin, start);

// Wiki meta namespaces must be rejected
check("Portal rejected",  R("/wiki/Portal:Current_events") === null, R("/wiki/Portal:Current_events"));
check("Help rejected",    R("/wiki/Help:Contents") === null, R("/wiki/Help:Contents"));
check("Wikipedia: rejected", R("/wiki/Wikipedia:About") === null, R("/wiki/Wikipedia:About"));
check("Special rejected", R("/wiki/Special:Random") === null, R("/wiki/Special:Random"));
check("Category rejected", R("/wiki/Category:History") === null, R("/wiki/Category:History"));
check("Main_Page rejected", R("/wiki/Main_Page") === null, R("/wiki/Main_Page"));

// Real articles must pass
check("article kept", R("/wiki/Sepoy") !== null, String(R("/wiki/Sepoy")));
check("article kept 2", R("/wiki/East_India_Company") !== null, String(R("/wiki/East_India_Company")));

// Utility paths on normal sites
const o2 = "https://example.com", c2 = "https://example.com/docs/intro", s2 = "/docs/intro";
const R2 = (h) => resolveLink(h, c2, o2, s2);
check("login rejected", R2("/login") === null, String(R2("/login")));
check("cart rejected", R2("/cart") === null, String(R2("/cart")));
check("privacy rejected", R2("/privacy") === null, String(R2("/privacy")));
check("root landing rejected", R2("/") === null, String(R2("/")));
check("docs page kept", R2("/docs/advanced") !== null, String(R2("/docs/advanced")));
// A real article whose slug merely contains a utility word must survive
check("how-we-search kept", R2("/blog/how-we-search") !== null, String(R2("/blog/how-we-search")));

// Entry point always allowed even if it looks like a landing page
check("start path allowed", resolveLink("/", "https://example.com/", o2, "/") !== null);

// Cross-origin and assets
check("cross-origin rejected", R("https://other.com/page") === null);
check("pdf rejected", R2("/docs/manual.pdf") === null, String(R2("/docs/manual.pdf")));

console.log(fail===0?"\nCRAWLER FILTER TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
