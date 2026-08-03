import { crawlWebsite } from "../scraper/crawler.js";
import { buildChunks, countTokens, freeEncoding } from "../processing/chunker.js";
import { embed, embedBatch, chat, EMBED_MODEL } from "../llm/ollama.js";
import { query } from "../db/client.js";
import {
    upsertKnowledgeBase,
    markReady,
    markFailed,
    replaceContent,
    searchChunks,
    listKnowledgeBases,
    getKnowledgeBaseByUrl,
    countChunks,
    countPages,
} from "../vectorstore/vectorStore.js";
import { buildMessages, REFUSAL_MESSAGE } from "./prompt.js";

/**
 * RAG pipeline for multi-site knowledge bases.
 *
 * One indexWebsite call crawls pages, chunks them, embeds them, and writes
 * them to Supabase. Later queries search across all ready knowledge bases
 * simultaneously so a question is answered from whichever site holds the data.
 */

/**
 * Indexes a website: crawl pages, chunk, embed, write to Supabase.
 *
 * Returns the knowledge base id. `onProgress` receives phase updates.
 * If the site is already indexed and useCache is true, returns immediately.
 *
 * `maxChunks` bounds the embedding work. Page count alone is a poor proxy for
 * cost: a documentation page can yield 150 chunks while a marketing page
 * yields 3, so a chunk cap is what actually keeps indexing time predictable.
 * Chunks are kept in document order, so the cap keeps the start of the site.
 */
export async function indexWebsite(url, options = {}) {
    const {
        maxPages = 12,
        maxChunks = Number(process.env.MAX_CHUNKS_PER_SITE) || 0,
        chunkTokens = Number(process.env.CHUNK_TOKENS) || 512,
        overlapTokens = Number(process.env.CHUNK_OVERLAP_TOKENS) || 64,
        onProgress = () => { },
        useCache = true,
        browser = null,
    } = options;

    const start = new URL(url);
    const origin = start.origin;

    const existing = await getKnowledgeBaseByUrl(url);

    if (useCache && existing && existing.status === "ready") {
        onProgress({ phase: "cached", kb: existing });
        return existing.id;
    }

    // Cap the number of sites. Re-indexing a site already present is always
    // allowed; only adding a new one beyond the limit is refused, so the user
    // gets a clear error instead of a silently truncated knowledge base.
    if (!existing) {
        const maxSites = Number(process.env.MAX_SITES) || 5;
        const siteCount = (await listKnowledgeBases()).length;
        if (siteCount >= maxSites) {
            throw new Error(
                `The knowledge base already holds ${siteCount} of a maximum ${maxSites} websites. ` +
                `Remove one before adding another.`
            );
        }
    }

    const kb = await upsertKnowledgeBase({
        siteUrl: url,
        siteTitle: start.hostname,
        origin,
        embedModel: EMBED_MODEL,
    });

    try {
        onProgress({ phase: "crawling", url });
        const pages = await crawlWebsite(url, {
            maxPages,
            browser,
            onProgress: (p) => onProgress({ phase: "crawling", ...p }),
        });

        onProgress({ phase: "chunking", pages: pages.length });
        let chunks = buildChunks(pages, { chunkTokens, overlapTokens });

        if (chunks.length === 0) {
            throw new Error("No usable chunks were built from this site");
        }

        const totalChunks = chunks.length;
        if (maxChunks > 0 && chunks.length > maxChunks) {
            chunks = chunks.slice(0, maxChunks);
            onProgress({ phase: "capped", kept: chunks.length, total: totalChunks });
        }

        // Only pages that still own a chunk are worth storing. Dropping the
        // others keeps page_count honest and avoids orphan rows after a cap.
        const usedPageIndexes = new Set(chunks.map((c) => c.pageIndex));
        const keptPages = pages.filter((_, i) => usedPageIndexes.has(i));

        // Chunks reference pages by index, so remap after filtering.
        const indexRemap = new Map();
        [...usedPageIndexes].sort((a, b) => a - b).forEach((oldIndex, newIndex) => {
            indexRemap.set(oldIndex, newIndex);
        });
        chunks = chunks.map((chunk) => ({
            ...chunk,
            pageIndex: indexRemap.get(chunk.pageIndex),
        }));

        const pagesWithTokens = keptPages.map((page) => ({
            ...page,
            tokenCount: countTokens(page.text),
        }));

        onProgress({ phase: "embedding", total: chunks.length, done: 0 });
        const embeddings = await embedBatch(
            chunks.map((c) => c.text),
            { onProgress: (p) => onProgress({ phase: "embedding", ...p }) }
        );

        onProgress({ phase: "writing" });
        await replaceContent(kb.id, pagesWithTokens, chunks, embeddings);

        const ready = await markReady(kb.id, {
            pageCount: pagesWithTokens.length,
            chunkCount: chunks.length,
        });

        onProgress({ phase: "done", kb: ready });
        return kb.id;
    } catch (error) {
        // A failed re-index must not destroy a working knowledge base. The old
        // chunks are still present (replaceContent never ran), so if any remain
        // the site is restored to ready rather than being hidden from retrieval
        // because of a transient network error.
        const surviving = await countChunks(kb.id).catch(() => 0);
        if (surviving > 0) {
            const pageRows = await countPages(kb.id).catch(() => 0);
            await markReady(kb.id, { pageCount: pageRows, chunkCount: surviving });
        } else {
            await markFailed(kb.id, error.message);
        }
        throw error;
    }
}

/**
 * Answers a question using retrieval across all ready knowledge bases.
 *
 * Returns { answer, sources, refusal: boolean }.
 */
export async function answerQuestion(question, options = {}) {
    const {
        topK = Number(process.env.RETRIEVAL_TOP_K) || 4,
        minScore = Number(process.env.RETRIEVAL_MIN_SCORE) || 0.35,
        history = [],
        onToken = null,
    } = options;

    const kbs = await listKnowledgeBases();
    const readyCount = kbs.filter((k) => k.status === "ready").length;

    if (readyCount === 0) {
        return {
            answer: "No knowledge bases are ready yet. Index at least one website first.",
            sources: [],
            refusal: true,
        };
    }

    // A request for a longer answer needs more source material to draw on, so
    // the retrieval budget is raised alongside the generation budget.
    const long = wantsLongAnswer(question);

    // Follow-ups are searched using the earlier topic they refer to.
    const searchQuery = resolveQuery(question, history);

    const questionEmbedding = await embed(searchQuery);
    const chunks = await searchChunks(questionEmbedding, {
        topK: long ? Math.max(topK * 2, 6) : topK,
        minScore,
        maxTokens: long
            ? Number(process.env.RETRIEVAL_MAX_TOKENS_LONG) || 1400
            : undefined,
    });

    if (chunks.length === 0 || !(await isLexicallyGrounded(searchQuery, chunks))) {
        return { answer: REFUSAL_MESSAGE, sources: [], refusal: true };
    }

    const messages = buildMessages(question, chunks, { history, long });

    // Generation is capped so a small model cannot wander past the context it
    // was given. The long budget is only unlocked when the question explicitly
    // asked for depth, because on CPU every extra token costs real time.
    const answer = await chat(messages, {
        onToken,
        numPredict: long
            ? Number(process.env.ANSWER_MAX_TOKENS_LONG) || 700
            : Number(process.env.ANSWER_MAX_TOKENS) || 160,
        // Structural stops that mean the model stopped extracting and started
        // composing. Inline enumeration stops are dropped for long answers,
        // where a genuine multi-part explanation may legitimately enumerate.
        stop: long
            ? ["\nPassages:", "\nQuestion:", "Answer using only"]
            : [
                "\n## ", "\n# ", "\n* ", "\n- ",
                "\n1. ", "\n2. ", " 2. ", " 3. ",
                "\nPassages:", "\nQuestion:", "Answer using only",
            ],
    });

    const sourceMap = new Map();
    for (const chunk of chunks) {
        const key = chunk.source.url;
        const existing = sourceMap.get(key);
        if (!existing || chunk.score > existing.score) {
            sourceMap.set(key, {
                url: chunk.source.url,
                title: chunk.source.title,
                siteTitle: chunk.source.siteTitle,
                score: Number(chunk.score.toFixed(3)),
            });
        }
    }

    // Citing pages under a refusal is contradictory: the model just stated it
    // found nothing in them.
    const refused = isRefusal(answer);

    return {
        answer: refused ? REFUSAL_MESSAGE : tidyAnswer(answer),
        sources: refused
            ? []
            : [...sourceMap.values()].sort((a, b) => b.score - a.score),
        refusal: refused,
    };
}

/**
 * Words too common to indicate topic overlap.
 *
 * Deliberately broad. If a question's only shared vocabulary with the corpus is
 * on this list, the corpus does not actually cover the question.
 *
 * Instruction verbs and format nouns ("write", "essay", "elaborate", "detail")
 * belong here too. They describe what to do with an answer, not what the answer
 * is about, so counting them as topic words dilutes the ratio and wrongly
 * refuses a valid request: "write a full essay on the war of independence"
 * yields [write, full, essay, war, independence], of which only two are real
 * subject terms, scoring 0.40 and failing a 0.5 threshold.
 */
const STOPWORDS = new Set(
    ("a an the and or but if then than that this these those of to in on at for with as is are was were be been " +
        "being it its by from can could will would shall should may might must do does did have has had i you he " +
        "she we they me him her us them my your his their our what which who whom whose when where why how all any " +
        "both each few more most other some such no nor not only own same so too very just about into over under " +
        "between during before after above below up down out off again further once here there while whether tell " +
        "give show explain describe define list summarise summarize mean means meaning happened happen " +
        "thing things something anything please " +
        // Instruction verbs: the request, not the subject.
        "write compose draft create make produce generate elaborate expand detail discuss analyse analyze " +
        "compare contrast outline review cover address answer respond continue rephrase reword clarify " +
        "simplify shorten lengthen add include mention state provide " +
        // Format and quantity nouns.
        "essay article report paragraph paragraphs page pages section sections summary overview introduction " +
        "conclusion note notes point points detail details example examples topic subject matter content " +
        "text piece writing full complete comprehensive detailed thorough brief short long longer more " +
        "further additional extra deeper depth length word words sentence sentences line lines").split(/\s+/)
);

/**
 * Phrases that signal the user wants a longer answer than the default.
 *
 * Length is treated as an explicit request rather than a guess: a factual
 * question should stay short and fast, while "write an essay" cannot be
 * satisfied in three sentences.
 */
const LENGTH_REQUEST =
    /\b(essay|elaborate|expand|in detail|detailed|comprehensive|thorough|at length|full(?:y)?\s+(?:explain|describe|cover)|more detail|go deeper|deep dive|write (?:a|an|me)?\s*(?:long|full|complete)|long(?:er)? (?:answer|response|explanation)|tell me (?:much )?more|several paragraphs|multiple paragraphs)\b/i;

/** True when the question asks for an expanded answer. */
export function wantsLongAnswer(question) {
    return LENGTH_REQUEST.test(question);
}

/**
 * Extracts the content words of a question: the terms that carry its subject.
 */
function questionTerms(question) {
    return [
        ...new Set(
            question
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s]/gu, " ")
                .split(/\s+/)
                .filter((w) => w.length > 2 && !STOPWORDS.has(w))
        ),
    ];
}

/**
 * Checks that the retrieved passages actually discuss what was asked.
 *
 * Cosine similarity alone cannot carry this decision. Measured on a Wikipedia
 * corpus about the Indian Rebellion of 1857:
 *
 *   "what was the Indian Rebellion of 1857"  -> 0.765   genuine
 *   "who were the sepoys"                    -> 0.651   genuine
 *   "what was the war of lalalala land"       -> 0.603   nonsense
 *
 * The nonsense question scores highly because "war" is genuinely close to
 * "rebellion" in embedding space, so no absolute floor separates the two: 0.62
 * would work here yet reject every real question on a corpus whose genuine
 * matches top out at 0.53. Relative cutoffs fail too, since they compare the
 * best hit against the others and never judge the best hit itself.
 *
 * A lexical check is the missing signal. A question whose subject the corpus
 * covers will share distinctive vocabulary with the retrieved text; "lalalala"
 * appears nowhere. Matching is prefix-based so ordinary morphology
 * ("rebellion" vs "rebellions") still counts, and the requirement is a
 * fraction rather than all terms, so paraphrases are not punished.
 *
 * A plain average over terms is not enough on its own: "what was the battle of
 * karbala" yields [battle, karbala], and on a corpus containing "battle" but no
 * mention of Karbala that averages to 0.5 and wrongly passes. The subject of a
 * question is its rarest word, so a distinctive term absent from the entire
 * corpus vetoes the question outright.
 */
async function isLexicallyGrounded(question, chunks) {
    const terms = questionTerms(question);

    // Nothing distinctive to check ("what is this about?"). Retrieval already
    // passed its own filters, so defer to it rather than refusing.
    if (terms.length === 0) return true;

    const haystack = chunks
        .map((c) => `${c.text} ${c.source.title ?? ""} ${c.source.siteTitle ?? ""}`)
        .join(" ")
        .toLowerCase();

    // Prefix match tolerates plurals and inflections without a stemmer.
    const present = (term) => {
        if (haystack.includes(term)) return true;
        const stem = term.length > 5 ? term.slice(0, Math.ceil(term.length * 0.75)) : term;
        return stem.length > 3 && haystack.includes(stem);
    };

    const missing = terms.filter((term) => !present(term));

    // Any term absent from the retrieved passages might still be common
    // elsewhere in the corpus. A term absent from the entire corpus is a
    // subject the knowledge base does not cover at all.
    if (missing.length > 0) {
        const absent = await termsAbsentFromCorpus(missing);
        if (absent.length > 0) return false;
    }

    const matched = terms.length - missing.length;

    // A single-term question must have that term present; there is no room for
    // a partial match to be meaningful.
    if (terms.length === 1) return matched === 1;

    const required = Number(process.env.GROUNDING_MIN_TERM_RATIO) || 0.5;
    return matched / terms.length >= required;
}

/**
 * Returns the subset of `terms` that appear nowhere in the stored corpus.
 *
 * Checked against the whole knowledge base rather than the retrieved passages,
 * because retrieval returns the nearest chunks whatever was asked: a term can
 * be missing from those few chunks yet be well covered elsewhere.
 */
async function termsAbsentFromCorpus(terms) {
    if (terms.length === 0) return [];

    const rows = await query(
        `select t.term
           from unnest($1::text[]) as t(term)
          where not exists (
                select 1 from kb_chunks c
                 where c.content ilike '%' || t.term || '%'
                 limit 1
          )`,
        [terms]
    );

    return rows.map((r) => r.term);
}

/**
 * Builds the text used for retrieval, resolving references to earlier turns.
 *
 * A follow-up such as "elaborate on this topic more" carries no subject of its
 * own: after instruction words are removed it has nothing left to search for or
 * to check against the corpus. Prepending the previous user question gives it
 * one, so the follow-up retrieves the same subject the conversation was already
 * about instead of depending on an incidental word match.
 */
function resolveQuery(question, history) {
    if (questionTerms(question).length > 0) return question;

    const previousQuestion = [...history]
        .reverse()
        .find((m) => m.role === "user" && questionTerms(m.content ?? "").length > 0);

    if (!previousQuestion) return question;

    return `${previousQuestion.content} ${question}`;
}

/**
 * Removes formatting the model copied out of the context.
 *
 * Chunks carry "## " section markers, and a model asked to quote closely will
 * reproduce them. Stripping here rather than relying on the prompt keeps the
 * output clean regardless of how well the model followed instructions.
 */
function tidyAnswer(answer) {
    let text = answer
        .split("\n")
        .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    // Drop a leading enumeration marker left behind when generation was cut at
    // a "2."-style stop sequence.
    text = text.replace(/^\d+\.\s*/, "");

    // A trailing fragment after the last sentence terminator is the tail of a
    // truncated thought; removing it is better than showing a half sentence.
    const lastStop = Math.max(
        text.lastIndexOf(". "),
        text.lastIndexOf("! "),
        text.lastIndexOf("? ")
    );
    if (!/[.!?]["')\]]?$/.test(text) && lastStop > 40) {
        text = text.slice(0, lastStop + 1);
    }

    return text.trim();
}

/**
 * Recognises a refusal even when the model dresses it up.
 *
 * Small models routinely prefix their own preamble ("There is no mention of X
 * in the passages...") or wrap the sentence in quotes, so an exact string
 * comparison reports a refusal as a real answer. Matching on the distinctive
 * core of the sentence catches those variants.
 */
function isRefusal(answer) {
    const normalise = (text) =>
        text
            .toLowerCase()
            .replace(/[""'']/g, "")
            .replace(/[^a-z0-9 ]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

    const normalised = normalise(answer);
    if (normalised === normalise(REFUSAL_MESSAGE)) return true;

    // The phrase is specific enough that its presence anywhere means the model
    // decided it could not answer.
    if (normalised.includes(normalise("could not find anything related to your query"))) {
        return true;
    }

    // Common paraphrases of the same decision.
    return [
        "no mention of",
        "not mentioned in the passages",
        "do not contain",
        "does not contain",
        "no information about",
        "cannot answer based on",
        "not found in the passages",
    ].some((phrase) => normalised.includes(normalise(phrase)));
}

/** Lists indexed sites with their status and counts. */
export async function listSites() {
    return listKnowledgeBases();
}

/** Release tokenizer memory on shutdown. */
export function cleanup() {
    freeEncoding();
}
