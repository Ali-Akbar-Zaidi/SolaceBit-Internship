import crypto from "node:crypto";

import puppeteer from "puppeteer";

/**
 * Puppeteer-based scraper.
 *
 * Renders each page in a real Chromium instance so JavaScript-driven content
 * (SPAs, lazy-loaded sections, client-side routing) is captured. A static HTML
 * parser only sees the initial server response, which on a modern site is
 * often an empty shell.
 *
 * One browser is shared across an entire crawl and pages are opened and closed
 * around it; launching Chromium per URL would dominate the runtime.
 */

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

// Resource types that never contribute text. Blocking them cuts page load time
// dramatically and avoids downloading megabytes of images per page.
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

// Elements removed before text extraction: chrome, navigation and adverts.
const NOISE_SELECTORS = [
    "script", "style", "noscript", "iframe", "svg", "canvas", "form",
    "nav", "footer", "header", "aside", "button", "template",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[role='search']", "[aria-hidden='true']", "[hidden]",
    ".nav", ".navbar", ".menu", ".footer", ".sidebar",
    ".advertisement", ".ads", ".cookie", ".cookie-banner", ".newsletter",
    ".social-share", ".breadcrumb", ".pagination", ".skip-link",
];

/** Launches a shared Chromium instance for a crawl. */
export async function launchBrowser(options = {}) {
    const { headless = true } = options;
    return puppeteer.launch({
        headless,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1366,900",
        ],
    });
}

/**
 * Extraction runs inside the browser. Receives the noise selectors because
 * the page context has no access to Node scope.
 *
 * Captures all visible text. Headings structure the output; everything else
 * is harvested from innerText so modern generic-container sites are covered.
 */
function extractInPage(noiseSelectors) {
    const title =
        document.title?.trim() ||
        document.querySelector("h1")?.innerText?.trim() ||
        location.href;

    // Links are harvested before pruning: most internal navigation lives in the
    // <nav> and <header> elements that are about to be removed.
    const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean);

    // Operate on a detached clone so the live DOM is never mutated.
    const root = document.body.cloneNode(true);
    root.querySelectorAll(noiseSelectors.join(",")).forEach((el) => el.remove());

    // Prefer a semantic content root when the page provides one.
    const main =
        root.querySelector("main") ||
        root.querySelector("article") ||
        root.querySelector("[role='main']") ||
        root;

    const headings = [];
    const paragraphs = [];
    const lines = [];

    // Block-level containers that may hold text. Modern sites put content in
    // div/span/section, so restricting this to p/li/blockquote would miss
    // JS-rendered cards, quotes and other generic-container layouts.
    const blockSelectors = [
        "p", "li", "blockquote", "pre", "td", "th", "dd", "dt", "figcaption",
        "div", "section", "article", "aside", "span",
    ];
    const headingSelector = "h1, h2, h3, h4, h5, h6";
    const blockSelector = blockSelectors.join(",");

    // One ordered pass over headings and blocks together. querySelectorAll
    // yields document order, which keeps each heading attached to the text it
    // introduces - important because chunks are later split on those markers.
    const nodes = main.querySelectorAll(`${headingSelector},${blockSelector}`);

    const seen = new Set();
    for (const el of nodes) {
        const isHeading = /^h[1-6]$/i.test(el.tagName);

        // Only take leaf blocks. A container is skipped when it holds another
        // block or a heading, otherwise a wrapper <div> would both duplicate
        // its children's text and consume the heading before the <h*> node is
        // reached (document order puts the wrapper first).
        if (!isHeading && el.querySelector(`${blockSelector},${headingSelector}`)) {
            continue;
        }

        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || seen.has(text)) continue;
        if (!isHeading && text.length < 3) continue;
        seen.add(text);

        if (isHeading) {
            headings.push(text);
            lines.push(`\n## ${text}\n`);
        } else {
            paragraphs.push(text);
            lines.push(text);
        }
    }

    return {
        title,
        headings,
        paragraphs,
        links,
        text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    };
}

/**
 * Scrolls to the bottom in steps to trigger lazy-loaded and infinite-scroll
 * content, then returns to the top. Bounded so an endless feed cannot hang
 * the crawl.
 */
async function autoScroll(page, maxScrolls = 12) {
    await page.evaluate(async (limit) => {
        await new Promise((resolve) => {
            let scrolled = 0;
            const step = window.innerHeight;
            const timer = setInterval(() => {
                window.scrollBy(0, step);
                scrolled += 1;
                const atBottom =
                    window.innerHeight + window.scrollY >=
                    document.body.scrollHeight - 100;
                if (atBottom || scrolled >= limit) {
                    clearInterval(timer);
                    window.scrollTo(0, 0);
                    resolve();
                }
            }, 220);
        });
    }, maxScrolls);
}

/**
 * Renders one URL and extracts its content.
 *
 * Returns { url, title, headings, paragraphs, text, links, contentHash }.
 * `url` is the post-redirect address so the crawler records where it landed.
 */
export async function scrapePage(browser, url, options = {}) {
    const {
        timeout = 30_000,
        waitUntil = "networkidle2",
        scroll = true,
        settleMs = 600,
    } = options;

    const page = await browser.newPage();

    try {
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1366, height: 900 });
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

        // Hide the automation flag; some sites serve a blank page to headless.
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        });

        await page.setRequestInterception(true);
        page.on("request", (request) => {
            if (request.isInterceptedRequestHandled?.()) return;
            if (BLOCKED_RESOURCES.has(request.resourceType())) {
                request.abort().catch(() => { });
            } else {
                request.continue().catch(() => { });
            }
        });

        const response = await page.goto(url, { waitUntil, timeout });

        if (!response) {
            throw new Error("Navigation returned no response");
        }
        const status = response.status();
        if (status >= 400) {
            throw new Error(`HTTP ${status}`);
        }
        const contentType = String(response.headers()["content-type"] || "");
        if (contentType && !contentType.includes("html")) {
            throw new Error(`Not an HTML page (content-type: ${contentType})`);
        }

        // Give client-side frameworks a moment to paint after network idle.
        await page.waitForSelector("body", { timeout: 5_000 }).catch(() => { });
        if (scroll) {
            await autoScroll(page).catch(() => { });
        }
        if (settleMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, settleMs));
        }

        const extracted = await page.evaluate(extractInPage, NOISE_SELECTORS);
        const finalUrl = page.url();

        return {
            url: finalUrl,
            title: extracted.title || finalUrl,
            headings: extracted.headings,
            paragraphs: extracted.paragraphs,
            text: extracted.text,
            links: extracted.links,
            contentHash: crypto
                .createHash("sha256")
                .update(extracted.text)
                .digest("hex"),
        };
    } finally {
        await page.close().catch(() => { });
    }
}

/** Scrapes a single URL, managing the browser lifecycle. Convenience helper. */
export async function scrapeSingle(url, options = {}) {
    const browser = await launchBrowser(options);
    try {
        return await scrapePage(browser, url, options);
    } finally {
        await browser.close().catch(() => { });
    }
}
