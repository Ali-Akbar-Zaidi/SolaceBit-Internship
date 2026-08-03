import { cleanText } from "../src/processing/cleaner.js";
let fail=0; const check=(n,c,e="")=>{ if(c) console.log("PASS "+n); else { console.log("FAIL "+n+" "+e); fail++; } };
const appendix = ["## A1. Appendix A: Git in Other Environments","A1.1 Graphical Interfaces","A1.2 Git in Visual Studio","A1.8 Git in PowerShell","A1.9 Summary"].join("\n");
check("appendix TOC removed", !/A1\.1 Graphical/.test(cleanText(appendix)), JSON.stringify(cleanText(appendix)));
const packedA = "A1.1 Graphical Interfaces A1.2 Git in Visual Studio A1.3 Git in Visual Studio Code A1.4 Git in IntelliJ";
check("packed appendix removed", cleanText(packedA).trim()==="", JSON.stringify(cleanText(packedA)));
// regressions
const prose="## About Version Control\nVersion control is a system that records changes to a file or set of files over time so that you can recall specific versions later.";
check("prose kept", cleanText(prose).includes("records changes"));
const dec="Latency dropped from 2.4 seconds to 1.1 seconds after enabling the 3.0 release.";
check("decimals kept", cleanText(dec).includes("Latency dropped"));
const step="1. Install the dependencies with npm install, which downloads every package listed in package.json.";
check("numbered step kept", cleanText(step).includes("Install the dependencies"));
const ver="Node.js 18.2 introduced the fetch API. Use version 20.1 or later for stable support.";
check("version prose kept", cleanText(ver).includes("fetch API"));
console.log(fail===0?"\nCLEANER TESTS PASSED":"\n"+fail+" FAILURE(S)"); process.exit(fail?1:0);
