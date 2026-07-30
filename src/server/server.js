import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cors from "cors";
import "dotenv/config";

import { indexWebsite, answerQuestion } from "../rag/pipeline.js";
import { checkOllama, chat, CHAT_MODEL, EMBED_MODEL } from "../llm/ollama.js";

/**
 * Phase 6 - Express backend
 *
 * REST API:
 *   GET  /api/health  - is Ollama up, are the models pulled, is a site loaded
 *   POST /api/index   - { url, maxPages? } starts building the knowledge base
 *   GET  /api/status  - progress of the current indexing job
 *   POST /api/chat    - { question, history? } answers from the knowledge base
 *
 * Also serves the chatbot UI from /public.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// In-memory application state (one active knowledge base at a time).
// ---------------------------------------------------------------------------
const state = {
    store: null,      // the active VectorStore
    site: null,       // { url, title, pages, chunks, indexedAt }
    indexing: null,   // { active, phase, detail, error, url }
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", async (req, res) => {
    const ollama = await checkOllama();
    res.json({
        ollama,
        models: { chat: CHAT_MODEL, embed: EMBED_MODEL },
        siteLoaded: Boolean(state.store),
        site: state.site,
    });
});

app.post("/api/index", async (req, res) => {
    const { url, maxPages } = req.body || {};

    if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "Please provide a 'url' string." });
    }
    let parsed;
    try {
        parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    } catch {
        return res.status(400).json({ error: "That doesn't look like a valid URL." });
    }
    if (state.indexing?.active) {
        return res.status(409).json({ error: "Already indexing a site. Please wait." });
    }

    const ollama = await checkOllama();
    if (!ollama.ok) {
        return res.status(503).json({
            error: ollama.reachable
                ? `Ollama is running but these models are missing: ${ollama.missing.join(", ")}. ` +
                `Run "ollama pull ${ollama.missing[0]}".`
                : "Ollama is not reachable at its configured address. Start Ollama and try again.",
        });
    }

    const targetUrl = parsed.toString();
    state.indexing = { active: true, phase: "starting", detail: {}, error: null, url: targetUrl };
    state.store = null;
    state.site = null;

    // Respond immediately; the UI polls /api/status for progress.
    res.status(202).json({ started: true, url: targetUrl });

    try {
        const pagesLimit = Math.min(Math.max(Number(maxPages) || 8, 1), 20);
        const store = await indexWebsite(targetUrl, {
            maxPages: pagesLimit,
            onProgress: (update) => {
                state.indexing = {
                    ...state.indexing,
                    phase: update.phase,
                    detail: update,
                };
            },
        });

        state.store = store;
        state.site = {
            url: store.meta.siteUrl,
            title: store.meta.siteTitle,
            pages: store.meta.pages,
            chunks: store.size,
            indexedAt: store.meta.indexedAt,
        };
        state.indexing = { ...state.indexing, active: false, phase: "done" };

        // Warm up the chat model in the background so the very first
        // question doesn't also pay the model-load cost.
        chat([{ role: "user", content: "Reply with OK." }]).catch(() => { });
    } catch (error) {
        console.error("Indexing failed:", error);
        state.indexing = {
            ...state.indexing,
            active: false,
            phase: "error",
            error: error.message,
        };
    }
});

app.get("/api/status", (req, res) => {
    res.json({
        indexing: state.indexing,
        siteLoaded: Boolean(state.store),
        site: state.site,
    });
});

app.post("/api/chat", async (req, res) => {
    const { question, history } = req.body || {};

    if (!question || typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "Please provide a 'question' string." });
    }
    if (!state.store) {
        return res.status(409).json({
            error: "No website has been indexed yet. Enter a URL and build the knowledge base first.",
        });
    }

    const safeHistory = Array.isArray(history)
        ? history
            .filter(
                (m) =>
                    m &&
                    (m.role === "user" || m.role === "assistant") &&
                    typeof m.content === "string"
            )
            .slice(-6)
        : [];

    // Stream the answer as newline-delimited JSON so the UI can render
    // tokens the moment the model produces them (no long blank wait).
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
        const result = await answerQuestion(question.trim(), state.store, {
            history: safeHistory,
            onToken: (token) => {
                res.write(JSON.stringify({ token }) + "\n");
            },
        });
        res.write(
            JSON.stringify({ done: true, answer: result.answer, sources: result.sources }) + "\n"
        );
        res.end();
    } catch (error) {
        console.error("Chat failed:", error);
        res.write(
            JSON.stringify({ error: `Failed to generate an answer: ${error.message}` }) + "\n"
        );
        res.end();
    }
});

app.listen(PORT, () => {
    console.log("");
    console.log("  Website RAG Chatbot");
    console.log("  -------------------");
    console.log(`  UI:      http://localhost:${PORT}`);
    console.log(`  Ollama:  chat=${CHAT_MODEL}  embeddings=${EMBED_MODEL}`);
    console.log("");
});
