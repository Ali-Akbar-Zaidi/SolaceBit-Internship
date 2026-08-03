import { cleanText } from "../src/processing/cleaner.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };

const cookie = "We use cookies to enhance your experience on our site.\nEssential cookies are necessary for the site to function.\nAnalytics cookies help us understand how visitors interact.";
check("cookie notice removed", cleanText(cookie).trim()==="", JSON.stringify(cleanText(cookie)));

const news = "Newsletter sign up to receive our weekly updates by email.";
check("newsletter removed", cleanText(news).trim()==="", JSON.stringify(cleanText(news)));

// Real prose that merely mentions cookies technically must survive
const real = "The HTTP specification defines how a server sets cookies in a response header, and browsers return them on later requests.";
check("technical cookie prose kept", cleanText(real).includes("HTTP specification"), JSON.stringify(cleanText(real)));

// Regressions
const prose = "Divine command theory holds that an action is morally right because God commands it, a view debated for centuries.";
check("prose kept", cleanText(prose).includes("Divine command"));
const dec = "Latency dropped from 2.4 seconds to 1.1 seconds after enabling the 3.0 release.";
check("decimals kept", cleanText(dec).includes("Latency dropped"));

console.log(fail===0?"\nCOOKIE FILTER TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
