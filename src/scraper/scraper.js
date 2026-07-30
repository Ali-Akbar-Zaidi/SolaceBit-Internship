import axios from "axios";
import * as cheerio from "cheerio";

/**
 * Phase 1 - Website Scraper
 *
 * Fetches a single page's raw HTML and extracts the meaningful content
 * (title, headings, paragraphs, list items) while discarding boilerplate
 * such as navigation bars, footers, scripts, styles and ads.
 */

const USER_AGENT =
    "Mozilla/5.0 (compatible; WebsiteRagChatbot/1.0; educational internship project)";

// Elements that never contain useful article text.
const NOISE_SELECTORS = [
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "canvas",
    "form",
    "nav",
    "footer",
    "header",
    "aside",
    "button",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[aria-hidden='true']",
    ".nav",
    ".navbar",
    ".menu",
    ".footer",
    ".sidebar",
    ".advertisement",
    ".cookie",
    ".cookie-banner",
].join(", ");

/**
 * Downloads the raw HTML of a URL.
 * Throws if the response is not HTML or the request fails.
 */
export async function fetchHtml(url) {
    const response = await axios.get(url, {
        timeout: 15000,
        maxRedirects: 5,
        responseType: "text",
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml",
        },
        // Treat 4xx/5xx as errors so we can report them clearly.
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const contentType = String(response.headers["content-type"] || "");
    if (!contentType.includes("html")) {
        throw new Error(`Not an HTML page (content-type: ${contentType})`);
    }

    return response.data;
}

/**
 * Parses raw HTML and extracts structured, de-noised content.
 * Returns { url, title, headings, paragraphs, text, links }.
 */
export function extractContent(html, url) {
    const $ = cheerio.load(html);

    const title =
        $("title").first().text().trim() ||
        $("h1").first().text().trim() ||
        url;

    // Collect in-site links BEFORE removing <nav>/<header>, because most
    // internal navigation links live there. The crawler needs them.
    const links = [];
    $("a[href]").each((_, el) => {
        links.push($(el).attr("href"));
    });

    // Now strip everything that is not real content.
    $(NOISE_SELECTORS).remove();

    // Prefer the semantic content root when the site provides one.
    const $root = $("main").length
        ? $("main").first()
        : $("article").length
            ? $("article").first()
            : $("body");

    const headings = [];
    $root.find("h1, h2, h3, h4").each((_, el) => {
        const heading = $(el).text().replace(/\s+/g, " ").trim();
        if (heading.length > 0) headings.push(heading);
    });

    const paragraphs = [];
    $root.find("p, li, blockquote, pre, td").each((_, el) => {
        // Skip nested duplicates (e.g. a <p> inside an <li> we already took).
        if ($(el).parents("li, blockquote, td").length > 0 && el.tagName === "p") {
            return;
        }
        const text = $(el).text().replace(/\s+/g, " ").trim();
        if (text.length > 0) paragraphs.push(text);
    });

    // Build one readable text document: headings act as section markers so
    // the chunker can keep related sentences together.
    const seen = new Set();
    const lines = [];

    $root.find("h1, h2, h3, h4, p, li, blockquote, pre, td").each((_, el) => {
        if ($(el).parents("li, blockquote, td").length > 0 && el.tagName === "p") {
            return;
        }
        const text = $(el).text().replace(/\s+/g, " ").trim();
        if (text.length === 0 || seen.has(text)) return;
        seen.add(text);

        if (/^h[1-4]$/.test(el.tagName)) {
            lines.push(`\n## ${text}\n`);
        } else {
            lines.push(text);
        }
    });

    const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

    return { url, title, headings, paragraphs, text, links };
}

/**
 * Scrapes a single webpage: fetch + extract.
 */
export async function scrapePage(url) {
    const html = await fetchHtml(url);
    return extractContent(html, url);
}

/**
 * Backwards-compatible helper kept from Phase 1: scrapes a page and
 * prints a readable report to the console.
 */
export async function scrapeWebsite(url) {
    try {
        const page = await scrapePage(url);

        console.log("\n==============================");
        console.log("PAGE TITLE");
        console.log("==============================");
        console.log(page.title);

        console.log("\n==============================");
        console.log("HEADINGS");
        console.log("==============================");
        page.headings.forEach((heading, index) => {
            console.log(`${index + 1}. ${heading}`);
        });

        console.log("\n==============================");
        console.log("PARAGRAPHS");
        console.log("==============================");
        page.paragraphs.forEach((paragraph, index) => {
            console.log(`${index + 1}. ${paragraph}\n`);
        });

        return page;
    } catch (error) {
        console.error("Error scraping website:");
        console.error(error.message);
        return null;
    }
}
