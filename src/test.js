import { scrapeWebsite } from "./scraper/scraper.js";

const url = "https://nodejs.org/en/learn/getting-started/introduction-to-nodejs";

await scrapeWebsite(url);