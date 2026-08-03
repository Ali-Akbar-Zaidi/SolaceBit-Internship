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
    /^(privacy policy|terms of (use|service)|cookie policy)$/i,
    /^(share|follow us|subscribe|sign (in|up)|log ?in|register)$/i,
    /^(skip to (main )?content|back to top|read more|learn more)$/i,
    /^(home|menu|search|previous|next)$/i,
    // Consent notices are written as full sentences, so they survive every
    // structural test and then get quoted back as if they were content.
    /\bcookies?\b.*\b(enhance|improve|experience|necessary|function|analytics|consent|preferences)\b/i,
    /\b(essential|analytics|marketing|functional) cookies?\b/i,
    /\bwe use cookies?\b/i,
    /\byour (privacy|consent) (choices|preferences|settings)\b/i,
    /\b(newsletter|mailing list)\b.*\b(sign ?up|subscribe|join)\b/i,
];

/**
 * Detects a table-of-contents line: a run of numbered section titles with
 * little connecting prose, e.g.
 *   "1.1 About Version Control 1.2 A Short History of Git 1.3 What is Git?"
 *
 * These lines score highly against topical questions because they are dense
 * with the right keywords, yet they contain no answer. Retrieval alone cannot
 * tell them apart from real prose, so they are dropped at index time.
 */
function isTableOfContents(line) {
    const words = line.split(/\s+/).filter(Boolean);

    // Navigation entries arrive one per line ("1.1 About Version Control"),
    // not as a single line packed with markers. The test therefore has to be
    // per line: a short line that opens with a section number and never
    // becomes a sentence is a link label, not content.
    // Appendices number themselves "A1.1", "B2.3", so an optional letter prefix
    // is part of the marker shape.
    if (/^[A-Z]?\d+(\.\d+)*\.?\s+\S/.test(line)) {
        const body = line.replace(/^[A-Z]?\d+(\.\d+)*\.?\s+/, "");

        // Real prose ends in terminal punctuation; a TOC label does not. The
        // "?" is excluded from that check because chapter titles legitimately
        // end in one ("1.3 What is Git?").
        const looksLikeSentence = /[.!]$/.test(body) || body.split(/\s+/).length > 9;
        if (!looksLikeSentence) return true;
    }

    // Some sites emit the whole contents list as one long line instead.
    // Requiring that the line not end like a sentence is what separates a run
    // of section labels from prose that merely cites several decimal figures
    // ("latency fell from 2.4 to 1.1 seconds on 3.0").
    const markers = line.match(/\b[A-Z]?\d+\.\d+\b/g);
    if (markers && markers.length >= 3 && !/[.!]$/.test(line)) {
        if (words.length / markers.length <= 6) return true;
    }

    return false;
}

/**
 * Cleans a single page's text:
 * - normalizes whitespace and unicode quirks
 * - drops boilerplate lines and tiny fragments
 * - removes exact duplicate lines
 */
/**
 * Section headings whose contents are apparatus rather than subject matter.
 *
 * These sections are dense with the article's own title and keywords, so they
 * embed extremely well against any question about the topic while containing no
 * answer. Measured on the Indian Rebellion of 1857 article, asking "what caused
 * the rebellion" ranked them above the section that explains the causes:
 *
 *   0.762  "In popular culture"  (novel and film plots)
 *   0.755  "External links"      (library resources, maps)
 *   0.752  bibliography          (author names, page numbers)
 *
 * Retrieval cannot distinguish them from body text, so they are dropped at
 * index time along with everything up to the next real heading.
 */
const TAIL_SECTION_HEADINGS =
    /^(references?|external links?|further reading|see also|notes?|citations?|bibliography|sources?|footnotes?|works cited|in popular culture|popular culture|in fiction|media|gallery|gallery of images|gallery of|awards?|honours?|honors?|gallery|related pages?|navigation|contents?)$/i;

/**
 * Sub-headings that legitimately appear inside an apparatus section.
 *
 * The extractor flattens every heading level to "## ", so a subsection reads as
 * a sibling of the section containing it. Without this, "## In popular culture"
 * is followed by "## Films", "## Theatre" and "## Literature", each of which
 * clears the tail-section flag and lets the trivia straight back in.
 *
 * A heading in this list does not end the section it sits inside; anything else
 * does.
 */
const TAIL_SUBSECTION_HEADINGS =
    /^(films?|movies?|television|tv|theatre|theater|literature|novels?|books?|poetry|music|folk music|songs?|games?|video games?|comics?|art|paintings?|documentaries|radio|adaptations?|references in|depictions?|portrayals?|in media|primary sources?|secondary sources?|tertiary sources?|text-?books?( and academic monographs)?|articles? in journals?( and collections?)?|academic monographs?|other histories|first person accounts?( and classic histories)?|historiography( and memory)?|online books?|archives?|manuscripts?)$/i;

/** True when a heading opens a section of apparatus rather than content. */
function isTailSectionHeading(headingText) {
    return TAIL_SECTION_HEADINGS.test(headingText.replace(/\s*\[edit\]\s*$/i, "").trim());
}

/** True when a heading is a subsection that belongs to an apparatus section. */
function isTailSubsectionHeading(headingText) {
    return TAIL_SUBSECTION_HEADINGS.test(headingText.replace(/\s*\[edit\]\s*$/i, "").trim());
}

/**
 * Detects a citation line that appears outside a references section.
 *
 * Inline citations survive the section filter because they sit in the body, yet
 * they are the same problem: publisher names, years and page ranges that embed
 * against the topic and answer nothing. Recognised by the citation apparatus
 * itself - ISBNs, publisher-and-year parentheticals, page ranges, retrieval
 * dates - rather than by position.
 */
function isCitationLine(line) {
    if (/\b(isbn|issn|doi|oclc|jstor|arxiv)\b/i.test(line)) return true;
    if (/\{\{cite\b/i.test(line)) return true;
    if (/\bretrieved\s+\d{1,2}\s+\w+\s+\d{4}/i.test(line)) return true;
    if (/\barchived from the original\b/i.test(line)) return true;

    // "(Place: Publisher, 1998)" or "(Delhi: Oxford University Press, 1998)".
    if (/\([A-Z][\w\s.]*:\s*[^)]*,\s*(19|20)\d{2}\)/.test(line)) return true;

    // A line that is mostly page ranges: "28- 20- 290- 45-".
    const ranges = line.match(/\b\d{1,4}\s*[-–]\s*\d{0,4}/g);
    if (ranges && ranges.length >= 3) return true;

    return false;
}

/**
 * Cleans a single page's text:
 * - normalizes whitespace and unicode quirks
 * - drops boilerplate lines and tiny fragments
 * - drops apparatus sections (references, external links, trivia)
 * - removes exact duplicate lines
 */
export function cleanText(rawText) {
    const seen = new Set();
    const cleaned = [];

    // Once a tail-section heading is seen, its lines are skipped until the next
    // heading. Wikipedia places these at the end, so in practice this discards
    // the remainder of the page, but evaluating each heading independently means
    // a genuine section appearing afterwards is still kept.
    let inTailSection = false;

    for (let line of rawText.split("\n")) {
        line = line
            .replace(/\u00a0/g, " ")   // non-breaking spaces
            .replace(/[ \t]+/g, " ")   // collapse runs of spaces/tabs
            .trim();

        if (line.length === 0) {
            if (!inTailSection) cleaned.push("");
            continue;
        }

        const isHeading = line.startsWith("## ");
        const plain = isHeading ? line.slice(3) : line;

        if (isHeading) {
            if (isTailSectionHeading(plain)) {
                // Entering an apparatus section.
                inTailSection = true;
                continue;
            }
            // Inside one, a recognised subsection keeps the section open. Any
            // other heading means the apparatus section has ended.
            if (inTailSection && isTailSubsectionHeading(plain)) continue;
            inTailSection = false;
        } else if (inTailSection) {
            continue;
        }

        // Drop obvious boilerplate.
        if (BOILERPLATE_PATTERNS.some((re) => re.test(plain))) continue;

        // Drop navigation tables of contents, which retrieve well but answer
        // nothing.
        if (isTableOfContents(plain)) continue;

        // Drop inline citations that sit outside a references section.
        if (!isHeading && isCitationLine(plain)) continue;

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
