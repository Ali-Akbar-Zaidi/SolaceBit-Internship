import { launchBrowser, scrapePage } from "./scraper.js";

/**
 * Same-site breadth-first crawler.
 *
 * Walks up to `maxPages` pages from a starting URL, staying on the same origin,
 * and returns the rendered content of each. A single Chromium instance is
 * reused for the whole crawl and closed at the end.
 */

// Extensions that are definitely not HTML documents.
const SKIP_EXTENSIONS =
    /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|rss|atom|zip|tar|gz|rar|7z|mp3|mp4|avi|mov|webm|woff2?|ttf|eot|exe|dmg|apk|csv|xlsx?|docx?|pptx?)$/i;

// Query parameters that vary per visit but do not change the page.
const TRACKING_PARAMS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "ref", "referrer", "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid",
];

/**
 * Wiki namespace prefixes that hold site machinery rather than articles.
 *
 * A wiki links to these from every page, so an unguarded crawl starting at one
 * article fills up with portals, help pages and policy text. Those pages embed
 * and retrieve like any other content, which lets an unrelated question find a
 * confident-looking match.
 */
const WIKI_META_NAMESPACES =
    /\/(portal|help|special|talk|category|file|template|wikipedia|user|draft|mediawiki|module|book|timedtext|topic)[:%]/i;

/**
 * Utility and account pages that exist on ordinary sites for the same reason.
 * Matched on whole path segments so a legitimate article such as
 * /blog/how-we-search is not caught by the word "search".
 */
const UTILITY_PATHS =
    /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|logout|account|cart|checkout|basket|search|admin|dashboard|preferences|settings|donate|privacy|terms|cookie-policy|legal|sitemap|rss|feed)(\/|$)/i;

/**
 * Landing pages, which are navigation rather than subject matter.
 *
 * Matched on the final path segment rather than the root, because a wiki puts
 * its front page at /wiki/Main_Page rather than at /.
 */
const LANDING_PATHS = /(^|\/)(index\.\w+|home|main_page|main-page|frontpage|front-page)$/i;

/**
 * Disambiguation pages list links to other articles instead of covering a
 * subject themselves. Their entire text is of the form "X may refer to Y, Z",
 * which retrieves strongly against a topical question and then answers it with
 * a stub such as "The Indian War of Independence may refer to various events,
 * including:". Wikipedia and similar wikis mark them in the URL.
 */
const DISAMBIGUATION_PATHS = /\(disambiguation\)/i;

/**
 * True when a URL sits in the same directory as the crawl entry point.
 *
 * Used only to order the queue, never to exclude a link. On a wiki every
 * article shares one flat prefix, so this is a weak signal there and a strong
 * one on sites that group content into sections such as /docs/ or /blog/.
 */
function isSibling(url, startPath) {
    if (!startPath) return false;
    const dir = startPath.slice(0, startPath.lastIndexOf("/") + 1);
    if (dir.length <= 1) return false;
    try {
        return new URL(url).pathname.startsWith(dir);
    } catch {
        return false;
    }
}

/** Canonicalises a URL so the same page is never queued twice. */
export function normalizeUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    url.searchParams.sort();

    let normalized = url.toString();
    if (normalized.endsWith("/") && url.pathname !== "/") {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

/**
 * Resolves an href against the current page and decides whether it is a
 * crawlable same-origin HTML link. Returns the normalized URL or null.
 *
 * `startPath` is the path the crawl began at. It is always allowed through, so
 * a crawl that deliberately starts on a landing or help page still works.
 */
export function resolveLink(href, currentUrl, origin, startPath = null) {
    if (!href) return null;

    const trimmed = href.trim();
    if (
        trimmed === "" ||
        trimmed.startsWith("#") ||
        /^(mailto|tel|javascript|data|blob|ftp):/i.test(trimmed)
    ) {
        return null;
    }

    let resolved;
    try {
        resolved = new URL(trimmed, currentUrl);
    } catch {
        return null;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    if (resolved.origin !== origin) return null;
    if (SKIP_EXTENSIONS.test(resolved.pathname)) return null;

    const path = resolved.pathname;

    // The entry point is always permitted, whatever it looks like.
    if (startPath && path === startPath) {
        return normalizeUrl(resolved.toString());
    }

    // Site machinery: present on every page, relevant to none of them.
    if (WIKI_META_NAMESPACES.test(path)) return null;
    if (UTILITY_PATHS.test(path)) return null;
    if (path === "/" || LANDING_PATHS.test(path)) return null;
    if (DISAMBIGUATION_PATHS.test(decodeURIComponent(path))) return null;

    return normalizeUrl(resolved.toString());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detects a disambiguation page from its content.
 *
 * The URL filter catches the "(disambiguation)" convention, but a wiki also
 * serves these at plain titles - "The Indian War of Independence" is one. They
 * are recognisable by their boilerplate: a "may refer to" opening, or the
 * closing note that the page lists articles sharing a title.
 *
 * They matter because they read as highly relevant to a topical question while
 * containing no answer, so the model responds with a stub like "X may refer to
 * various events, including:".
 */
export function isDisambiguationPage(page) {
    const text = page.text ?? "";
    const title = page.title ?? "";

    if (/\(disambiguation\)/i.test(title)) return true;

    // The standard wiki footer on these pages.
    if (/this disambiguation page lists articles/i.test(text)) return true;
    if (/topics referred to by the same term/i.test(text)) return true;

    // "X may refer to" near the start, with the page being mostly that list.
    const opening = text.slice(0, 400);
    if (/\bmay (?:refer|also refer) to\b/i.test(opening)) {
        // A real article can use the phrase in passing, so require the page to
        // be short: a genuine article on the subject would be far longer.
        if (text.length < 4000) return true;
    }

    return false;
}

/**
 * Crawls up to `maxPages` same-origin pages starting at `startUrl`.
 *
 * `onProgress({ crawled, total, url })` fires after each successful page.
 * An existing `browser` may be supplied to share one instance across several
 * crawls; otherwise a private one is launched and closed here.
 *
 * Throws if not a single page yields usable text.
 */
export async function crawlWebsite(startUrl, options = {}) {
    const {
        maxPages = 8,
        delayMs = 400,
        minTextLength = 120,
        onProgress = () => { },
        browser: externalBrowser = null,
        // Heavy marketing pages routinely need more than 30s to reach network
        // idle, and a timeout there loses the whole site rather than one page.
        pageTimeout = Number(process.env.PAGE_TIMEOUT_MS) || 45_000,
    } = options;

    const start = new URL(startUrl);
    const origin = start.origin;
    const startPath = start.pathname;

    const queue = [normalizeUrl(start.toString())];
    const visited = new Set();
    const pages = [];
    const failures = [];

    const browser = externalBrowser || (await launchBrowser());

    try {
        while (queue.length > 0 && pages.length < maxPages) {
            const url = queue.shift();
            if (visited.has(url)) continue;
            visited.add(url);

            try {
                const page = await scrapePage(browser, url, { timeout: pageTimeout });

                // A redirect may land on a URL already crawled.
                const landed = normalizeUrl(page.url);
                if (landed !== url && visited.has(landed)) continue;
                visited.add(landed);

                if (page.text.length >= minTextLength && !isDisambiguationPage(page)) {
                    pages.push({
                        url: page.url,
                        title: page.title,
                        headings: page.headings,
                        paragraphs: page.paragraphs,
                        text: page.text,
                        contentHash: page.contentHash,
                    });
                    onProgress({ crawled: pages.length, total: maxPages, url: page.url });
                }

                // Links sharing the entry point's directory are far more likely
                // to be about the same subject, so they are crawled first. A
                // breadth-first walk of a large site otherwise spends its page
                // budget on whatever the navigation happens to link to.
                const siblings = [];
                const others = [];

                for (const href of page.links) {
                    const next = resolveLink(href, page.url, origin, startPath);
                    if (!next || visited.has(next) || queue.includes(next)) continue;
                    (isSibling(next, startPath) ? siblings : others).push(next);
                }

                for (const url of [...siblings, ...others]) {
                    if (queue.length + pages.length > maxPages * 12) break;
                    queue.push(url);
                }
            } catch (error) {
                // One bad page must not abort the crawl.
                failures.push({ url, error: error.message });
                console.warn(`  skipped ${url}: ${error.message}`);
            }

            if (queue.length > 0 && pages.length < maxPages) {
                await sleep(delayMs);
            }
        }
    } finally {
        if (!externalBrowser) {
            await browser.close().catch(() => { });
        }
    }

    if (pages.length === 0) {
        const detail = failures.length
            ? ` Last error: ${failures[failures.length - 1].error}`
            : "";
        throw new Error(
            `Could not extract readable content from any page on ${origin}.${detail}`
        );
    }

    return pages;
}
