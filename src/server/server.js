import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cors from "cors";
import "dotenv/config";

import { indexWebsite, answerQuestion, cleanup } from "../rag/pipeline.js";
import { checkOllama, chat, embed, CHAT_MODEL, EMBED_MODEL } from "../llm/ollama.js";
import {
    checkDatabase,
    migrate,
    closePool,
} from "../db/client.js";
import {
    listKnowledgeBases,
    deleteKnowledgeBase,
    getKnowledgeBaseByUrl,
    getStats,
    listPages,
    recoverStaleIndexing,
} from "../vectorstore/vectorStore.js";

/**
 * Express backend.
 *
 * REST API:
 *   GET    /api/health        - Ollama + database status, corpus stats
 *   GET    /api/sites         - every indexed knowledge base
 *   GET    /api/sites/:id     - pages within one knowledge base
 *   POST   /api/index         - { url, maxPages? } start indexing a site
 *   DELETE /api/sites/:id     - remove a knowledge base
 *   GET    /api/status        - progress of running / recent index jobs
 *   POST   /api/chat          - { question, history? } answer from the corpus
 *
 * Also serves the UI from /public.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

/**
 * Progress for indexing jobs, keyed by URL. Indexing is long-running, so the
 * request returns immediately and the UI polls /api/status. Persisted state
 * lives in Postgres; this map only tracks in-flight progress.
 */
const jobs = new Map();

function setJob(url, patch) {
    jobs.set(url, { ...(jobs.get(url) || { url }), ...patch });
}

/** Normalises user input into an absolute http(s) URL, or throws. */
function parseUrl(input) {
    const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http and https URLs are supported");
    }
    return url.toString().replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Health and inventory
// ---------------------------------------------------------------------------

app.get("/api/health", async (req, res) => {
    const [ollama, database, stats] = await Promise.all([
        checkOllama(),
        checkDatabase(),
        getStats().catch(() => null),
    ]);

    res.json({
        ollama,
        database: {
            ok: database.ok,
            reachable: database.reachable,
            missing: database.missing,
            error: database.error,
        },
        models: { chat: CHAT_MODEL, embed: EMBED_MODEL },
        stats,
        ready: ollama.ok && database.ok && (stats?.ready_sites ?? 0) > 0,
    });
});

app.get("/api/sites", async (req, res) => {
    try {
        const sites = await listKnowledgeBases();
        res.json({ sites, stats: await getStats() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/sites/:id", async (req, res) => {
    try {
        const pages = await listPages(req.params.id);
        res.json({ pages });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete("/api/sites/:id", async (req, res) => {
    try {
        const deleted = await deleteKnowledgeBase(req.params.id);
        if (!deleted) return res.status(404).json({ error: "Knowledge base not found" });
        res.json({ deleted: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

app.post("/api/index", async (req, res) => {
    const { url, maxPages } = req.body || {};

    if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "Please provide a 'url' string." });
    }

    let targetUrl;
    try {
        targetUrl = parseUrl(url.trim());
    } catch {
        return res.status(400).json({ error: "That doesn't look like a valid URL." });
    }

    if (jobs.get(targetUrl)?.active) {
        return res.status(409).json({
            error: "This site is already being indexed. Wait for it to finish or cancel it first.",
        });
    }

    // The site cap is checked before responding. Indexing runs in the
    // background after a 202, so a limit breach discovered inside the job would
    // only reach the user through status polling.
    try {
        const existing = await getKnowledgeBaseByUrl(targetUrl);
        if (!existing) {
            const maxSites = Number(process.env.MAX_SITES) || 5;
            const sites = await listKnowledgeBases();
            if (sites.length >= maxSites) {
                return res.status(409).json({
                    error:
                        `The knowledge base already holds ${sites.length} of a maximum ${maxSites} websites. ` +
                        `Remove one before adding another.`,
                });
            }
        }
    } catch (error) {
        return res.status(503).json({ error: `Database unavailable: ${error.message}` });
    }

    const [ollama, database] = await Promise.all([checkOllama(), checkDatabase()]);

    if (!ollama.ok) {
        return res.status(503).json({
            error: ollama.reachable
                ? `Ollama is running but these models are missing: ${ollama.missing.join(", ")}. ` +
                `Run "ollama pull ${ollama.missing[0]}".`
                : "Ollama is not reachable. Start Ollama and try again.",
        });
    }
    if (!database.ok) {
        return res.status(503).json({
            error: database.reachable
                ? `Database schema incomplete. Missing: ${database.missing.join(", ")}. Run "npm run migrate".`
                : `Database unreachable: ${database.error}`,
        });
    }

    const pagesLimit = Math.min(Math.max(Number(maxPages) || 12, 1), 30);

    setJob(targetUrl, { active: true, phase: "starting", detail: {}, error: null });
    res.status(202).json({ started: true, url: targetUrl });

    try {
        await indexWebsite(targetUrl, {
            maxPages: pagesLimit,
            onProgress: (update) =>
                setJob(targetUrl, { phase: update.phase, detail: update }),
        });
        setJob(targetUrl, { active: false, phase: "done" });

        // Warm the chat model so the first question is not also paying the
        // model load cost.
        chat([{ role: "user", content: "Reply with OK." }]).catch(() => { });
    } catch (error) {
        console.error(`Indexing ${targetUrl} failed:`, error.message);
        setJob(targetUrl, { active: false, phase: "error", error: error.message });
    }
});

app.get("/api/status", async (req, res) => {
    try {
        res.json({
            jobs: [...jobs.values()],
            sites: await listKnowledgeBases(),
            stats: await getStats(),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
    const { question, history } = req.body || {};

    if (!question || typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "Please provide a 'question' string." });
    }

    const stats = await getStats().catch(() => null);
    if (!stats || stats.ready_sites === 0) {
        return res.status(409).json({
            error: "No knowledge bases are ready. Index at least one website first.",
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

    // NDJSON so the UI can render tokens as they arrive.
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
        const result = await answerQuestion(question.trim(), {
            history: safeHistory,
            onToken: (token) => res.write(JSON.stringify({ token }) + "\n"),
        });
        res.write(
            JSON.stringify({
                done: true,
                answer: result.answer,
                sources: result.sources,
                refusal: result.refusal,
            }) + "\n"
        );
        res.end();
    } catch (error) {
        console.error("Chat failed:", error.message);
        res.write(JSON.stringify({ error: `Failed to generate an answer: ${error.message}` }) + "\n");
        res.end();
    }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = app.listen(PORT, async () => {
    // Applying the schema on boot keeps a fresh clone one command from running.
    try {
        await migrate();
    } catch (error) {
        console.error("Schema migration failed on boot:", error.message);
    }

    const database = await checkDatabase();

    // No indexing job survives a restart, so any row still marked "indexing"
    // was stranded by a crash and would otherwise stay invisible to retrieval.
    if (database.ok) {
        try {
            const { restored, failed } = await recoverStaleIndexing();
            for (const url of restored) {
                console.log(`  recovered interrupted index: ${url}`);
            }
            for (const url of failed) {
                console.log(`  marked failed (no content): ${url}`);
            }
        } catch (error) {
            console.error("Recovery of interrupted indexes failed:", error.message);
        }
    }

    console.log("");
    console.log("  Website RAG Chatbot");
    console.log("  -------------------");
    console.log(`  UI:       http://localhost:${PORT}`);
    console.log(`  Ollama:   chat=${CHAT_MODEL}  embeddings=${EMBED_MODEL}`);
    console.log(
        `  Database: ${database.ok ? "connected (pgvector)" : `PROBLEM - ${database.error || database.missing.join(", ")}`}`
    );
    console.log("");

    // Load both models into memory now. The first question would otherwise pay
    // a one-off model load on top of its own latency, which reads as the app
    // being slow when it is really just cold.
    warmUp();
});

/**
 * Sends a trivial request to each model so they are resident before the first
 * real query. Failures are ignored: this is an optimisation, not a dependency.
 */
function warmUp() {
    embed("warm up").catch(() => { });
    chat([{ role: "user", content: "Reply with OK." }], { numPredict: 4 }).catch(() => { });
}

async function shutdown(signal) {
    console.log(`\n${signal} received, shutting down.`);
    server.close();
    cleanup();
    await closePool().catch(() => { });
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
