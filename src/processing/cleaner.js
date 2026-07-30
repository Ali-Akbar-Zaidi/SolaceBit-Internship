/**
 * Phase 2a - Text Cleaner
 *
 * Takes the raw extracted text of a page and turns it into clean,
 * de-duplicated prose ready for chunking.
 */

// Lines matching these are almost always boilerplate, not content.
const BOILERPLATE_PATTERNS = [
    /^(copyright|©|all rights reserved)/i,
    /^(accept|manage|reject)( all)? cookies?/i,
    /^(share|follow us|subscribe|sign (in|up)|log ?in|register)$/i,
    /^(privacy policy|terms of (use|service)|cookie policy)$/i,
    /^(skip to (main )?content|back to top|read more|learn more)$/i,
    /^(home|menu|search|previous|next)$/i,
];

/**
 * Cleans a single page's text:
 * - normalizes whitespace and unicode quirks
 * - drops boilerplate lines and tiny fragments
 * - removes exact duplicate lines
 */
export function cleanText(rawText) {
    const seen = new Set();
    const cleaned = [];

    for (let line of rawText.split("\n")) {
        line = line
            .replace(/\u00a0/g, " ")   // non-breaking spaces
            .replace(/[ \t]+/g, " ")   // collapse runs of spaces/tabs
            .trim();

        if (line.length === 0) {
            cleaned.push("");
            continue;
        }

        const isHeading = line.startsWith("## ");
        const plain = isHeading ? line.slice(3) : line;

        // Drop obvious boilerplate.
        if (BOILERPLATE_PATTERNS.some((re) => re.test(plain))) continue;

        // Drop tiny non-heading fragments ("Ok", "|", "->" etc.).
        if (!isHeading && plain.length < 3) continue;

        // Drop exact duplicates (repeated banners, repeated captions).
        const key = plain.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        cleaned.push(line);
    }

    return cleaned
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
