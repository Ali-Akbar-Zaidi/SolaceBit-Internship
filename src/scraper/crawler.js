import { fetchHtml, extractContent } from "./scraper.js";

/**
 * Phase 1.5 - Small-scale same-site crawler
 *
 * Starts from a URL and crawls a limited number of pages on the SAME site
 * (breadth-first), politely spacing out requests. Returns an array of
 * scraped pages: [{ url, title, headings, paragraphs, text }].
 */

// File extensions that are clearly not HTML pages.
const SKIP_EXTENSIONS =
    /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|rss|zip|tar|gz|rar|7z|mp3|mp4|avi|mov|webm|woff2?|ttf|eot|exe|dmg|apk)$/i;

/**
 * Normalizes a URL so the same page isn't visited twice
 * (strips #fragments, trailing slashes and common tracking params).
 */
function normalizeUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const param of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid"]) {
        url.searchParams.delete(param);
    }
    let normalized = url.toString();
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized;
}

/**
 * Resolves a raw href against the current page and decides whether it is
 * a crawlable, same-site HTML link. Returns the normalized URL or null.
 */
function resolveLink(href, currentUrl, origin) {
    if (!href) return null;
    const trimmed = href.trim();
    if (
        trimmed === "" ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("data:")
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
    if (resolved.origin !== origin) return null; // stay on the same site
    if (SKIP_EXTENSIONS.test(resolved.pathname)) return null;

    return normalizeUrl(resolved.toString());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Crawls up to `maxPages` pages starting at `startUrl` (breadth-first,
 * same-origin only). Calls `onProgress({ crawled, total, url })` as it goes.
 */
export async function crawlWebsite(startUrl, options = {}) {
    const { maxPages = 8, delayMs = 400, onProgress = () => { } } = options;

    const start = new URL(startUrl);
    const origin = start.origin;

    const queue = [normalizeUrl(start.toString())];
    const visited = new Set();
    const pages = [];

    while (queue.length > 0 && pages.length < maxPages) {
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);

        try {
            const html = await fetchHtml(url);
            const page = extractContent(html, url);

            // Keep only pages that actually contain some text.
            if (page.text.length >= 80) {
                pages.push({
                    url: page.url,
                    title: page.title,
                    headings: page.headings,
                    paragraphs: page.paragraphs,
                    text: page.text,
                });
                onProgress({ crawled: pages.length, total: maxPages, url });
            }

            // Enqueue same-site links discovered on this page.
            for (const href of page.links) {
                const next = resolveLink(href, url, origin);
                if (next && !visited.has(next) && !queue.includes(next)) {
                    queue.push(next);
                }
            }
        } catch (error) {
            // A single broken page must not kill the whole crawl.
            console.warn(`Skipping ${url}: ${error.message}`);
        }

        // Be polite: never hammer the server with rapid-fire requests.
        if (queue.length > 0 && pages.length < maxPages) {
            await sleep(delayMs);
        }
    }

    if (pages.length === 0) {
        throw new Error(
            "Could not extract readable content from any page. " +
            "The site may be JavaScript-rendered or blocking scrapers."
        );
    }

    return pages;
}
