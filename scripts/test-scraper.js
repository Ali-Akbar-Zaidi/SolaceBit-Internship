import { launchBrowser, scrapePage } from "../src/scraper/scraper.js";

// quotes.toscrape.com/js renders entirely via JavaScript - a static HTML
// parser sees an empty shell. This is the decisive Cheerio-vs-Puppeteer test.
const targets = [
  "https://quotes.toscrape.com/js/",
  "https://example.com",
];

const browser = await launchBrowser();
try {
  for (const url of targets) {
    const t0 = Date.now();
    try {
      const p = await scrapePage(browser, url);
      console.log("\n=== " + url + " ===");
      console.log("title:", p.title);
      console.log("chars:", p.text.length, "| headings:", p.headings.length, "| paras:", p.paragraphs.length, "| links:", p.links.length);
      console.log("ms:", Date.now()-t0);
      console.log("hash:", p.contentHash.slice(0,16));
      console.log("preview:", JSON.stringify(p.text.slice(0,220)));
    } catch (e) {
      console.log("\n=== " + url + " === FAILED:", e.message);
    }
  }

  // Prove the JS page really needs rendering: compare against raw HTML.
  const raw = await fetch("https://quotes.toscrape.com/js/").then(r=>r.text());
  const hasQuoteInRaw = /Einstein|world as we have created/i.test(raw);
  console.log("\n--- dynamic-content proof ---");
  console.log("quote text present in RAW html (cheerio would see this):", hasQuoteInRaw);
} finally {
  await browser.close();
}
