/**
 * SiteSage UI logic.
 *
 * - health badge (Ollama + Supabase reachability)
 * - knowledge base inventory with per-site delete
 * - indexing with progress polling
 * - chat with live token streaming over NDJSON
 *
 * Answers are retrieved across every ready knowledge base at once, so chat is
 * enabled as soon as the corpus is non-empty rather than after indexing a site
 * in this particular session.
 */

const urlForm = document.getElementById("url-form");
const urlInput = document.getElementById("url-input");
const maxPagesInput = document.getElementById("max-pages");
const indexBtn = document.getElementById("index-btn");
const progressWrap = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const siteInfo = document.getElementById("site-info");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatText = document.getElementById("chat-text");
const sendBtn = document.getElementById("send-btn");
const healthDot = document.getElementById("health-dot");
const healthText = document.getElementById("health-text");
const brandOrb = document.getElementById("brand-orb");
const orbWrap = document.getElementById("orb-wrap");
const aurora = document.getElementById("aurora");
const kbSummary = document.getElementById("kb-summary");
const kbList = document.getElementById("kb-list");
const kbRefresh = document.getElementById("kb-refresh");

// Recent conversation turns, sent so follow-up questions resolve.
const history = [];

const BOT_AVATAR_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M8 12h.01M16 12h.01M9 16h6"/></svg>';

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function makeMessage(role) {
    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;

    if (role === "bot" || role === "error") {
        const avatar = document.createElement("div");
        avatar.className = "avatar bot-avatar";
        avatar.innerHTML = BOT_AVATAR_SVG;
        wrapper.appendChild(avatar);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    wrapper.appendChild(bubble);

    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return { wrapper, bubble };
}

function addMessage(role, text, sources) {
    const { wrapper, bubble } = makeMessage(role);
    bubble.textContent = text;
    if (sources && sources.length > 0) appendSources(bubble, sources);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrapper;
}

function appendSources(bubble, sources) {
    const sourcesEl = document.createElement("div");
    sourcesEl.className = "sources";
    sourcesEl.append("Sources: ");
    sources.forEach((source, i) => {
        const link = document.createElement("a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.siteTitle
            ? `${source.title} - ${source.siteTitle}`
            : source.title || source.url;
        if (typeof source.score === "number") {
            link.title = `similarity ${source.score}`;
        }
        sourcesEl.appendChild(link);
        if (i < sources.length - 1) sourcesEl.append("  ·  ");
    });
    bubble.appendChild(sourcesEl);
}

function addTyping() {
    const { wrapper, bubble } = makeMessage("bot");
    bubble.innerHTML =
        '<span class="typing"><span></span><span></span><span></span></span>';
    return wrapper;
}

function setChatEnabled(enabled) {
    chatText.disabled = !enabled;
    sendBtn.disabled = !enabled;
}

function setProgress(percent, text) {
    progressWrap.classList.remove("hidden");
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    progressText.textContent = text;
}

// ---------------------------------------------------------------------------
// Knowledge base inventory
// ---------------------------------------------------------------------------

function renderSites(sites, stats) {
    kbList.innerHTML = "";

    if (!sites || sites.length === 0) {
        kbSummary.textContent = "No knowledge bases yet. Index a site to begin.";
        return;
    }

    const ready = sites.filter((s) => s.status === "ready");
    kbSummary.textContent =
        `${ready.length} site${ready.length === 1 ? "" : "s"} ready` +
        (stats ? ` · ${stats.pages} pages · ${stats.chunks} chunks` : "");

    for (const site of sites) {
        const item = document.createElement("li");
        item.className = `kb-item kb-${site.status}`;

        const main = document.createElement("div");
        main.className = "kb-main";

        const link = document.createElement("a");
        link.href = site.site_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "kb-title";
        link.textContent = site.site_title || site.site_url;
        main.appendChild(link);

        const meta = document.createElement("span");
        meta.className = "kb-meta";
        meta.textContent =
            site.status === "ready"
                ? `${site.page_count} pages · ${site.chunk_count} chunks`
                : site.status === "failed"
                    ? `failed: ${site.error || "unknown error"}`
                    : site.status;
        main.appendChild(meta);

        item.appendChild(main);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "kb-delete";
        remove.textContent = "Remove";
        remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
                const res = await fetch(`/api/sites/${site.id}`, { method: "DELETE" });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || `status ${res.status}`);
                }
                await loadSites();
                await checkHealth();
            } catch (error) {
                remove.disabled = false;
                addMessage("error", `Could not remove that knowledge base: ${error.message}`);
            }
        });
        item.appendChild(remove);

        kbList.appendChild(item);
    }
}

async function loadSites() {
    try {
        const res = await fetch("/api/sites");
        const data = await res.json();
        renderSites(data.sites, data.stats);
        return data;
    } catch {
        kbSummary.textContent = "Could not load knowledge bases.";
        return null;
    }
}

kbRefresh?.addEventListener("click", loadSites);

// ---------------------------------------------------------------------------
// 3D motion: cursor-tracked tilt, spotlight highlight, aurora parallax and a
// brand orb that turns toward the cursor. Skipped on touch devices; CSS honours
// prefers-reduced-motion.
// ---------------------------------------------------------------------------

const canHover = window.matchMedia("(hover: hover)").matches;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function attachTilt(el, strength) {
    if (!el) return;
    const reset = () => {
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
        el.style.setProperty("--mx", "50%");
        el.style.setProperty("--my", "50%");
    };
    el.addEventListener("mousemove", (event) => {
        const rect = el.getBoundingClientRect();
        const px = (event.clientX - rect.left) / rect.width;
        const py = (event.clientY - rect.top) / rect.height;
        el.style.setProperty("--rx", `${(0.5 - py) * strength}deg`);
        el.style.setProperty("--ry", `${(px - 0.5) * strength}deg`);
        el.style.setProperty("--mx", `${px * 100}%`);
        el.style.setProperty("--my", `${py * 100}%`);
    });
    el.addEventListener("mouseleave", reset);
    reset();
}

if (canHover && !prefersReducedMotion) {
    attachTilt(document.querySelector(".url-panel"), 4);
    attachTilt(document.querySelector(".chat"), 2);

    document.addEventListener("mousemove", (event) => {
        if (orbWrap) {
            const rect = orbWrap.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = (event.clientX - cx) / window.innerWidth;
            const dy = (event.clientY - cy) / window.innerHeight;
            orbWrap.style.transform = `rotateY(${dx * 26}deg) rotateX(${-dy * 26}deg)`;
        }
        if (aurora) {
            const x = (event.clientX / window.innerWidth - 0.5) * -24;
            const y = (event.clientY / window.innerHeight - 0.5) * -24;
            document.documentElement.style.setProperty("--parallax-x", `${x}px`);
            document.documentElement.style.setProperty("--parallax-y", `${y}px`);
        }
    });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function checkHealth() {
    try {
        const res = await fetch("/api/health");
        const data = await res.json();

        // Report the blocking problem first: without Ollama or the database,
        // nothing else works.
        if (!data.ollama.reachable) {
            healthDot.className = "health-dot bad";
            healthText.textContent = "Ollama is not running";
        } else if (data.ollama.missing.length > 0) {
            healthDot.className = "health-dot bad";
            healthText.textContent = `Missing models: ${data.ollama.missing.join(", ")}`;
        } else if (!data.database.reachable) {
            healthDot.className = "health-dot bad";
            healthText.textContent = "Supabase unreachable";
        } else if (!data.database.ok) {
            healthDot.className = "health-dot bad";
            healthText.textContent = "Database schema incomplete - run npm run migrate";
        } else {
            healthDot.className = "health-dot ok";
            const chunks = data.stats?.chunks ?? 0;
            healthText.textContent = `Ready · ${data.models.chat} · ${chunks} chunks`;
        }

        const healthy = data.ollama.ok && data.database.ok;
        brandOrb?.classList.toggle("status-bad", !healthy);

        // Chat only needs a non-empty corpus, not a site indexed in this tab.
        setChatEnabled(healthy && (data.stats?.ready_sites ?? 0) > 0);
        return data;
    } catch {
        healthDot.className = "health-dot bad";
        healthText.textContent = "Server unreachable";
        brandOrb?.classList.add("status-bad");
        setChatEnabled(false);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function describeProgress(job) {
    const d = job.detail || {};
    switch (job.phase) {
        case "starting":
            return { percent: 3, text: "Starting browser..." };
        case "cached":
            return { percent: 100, text: "Already indexed - loaded from Supabase." };
        case "crawling":
            return {
                percent: d.crawled ? 5 + (d.crawled / d.total) * 35 : 6,
                text: d.crawled
                    ? `Rendering pages... ${d.crawled}/${d.total} (${d.url || ""})`
                    : "Rendering pages...",
            };
        case "chunking":
            return { percent: 44, text: `Chunking ${d.pages} pages into tokens...` };
        case "embedding":
            return {
                percent: 46 + (d.total ? (d.done / d.total) * 46 : 0),
                text: `Embedding chunks... ${d.done ?? 0}/${d.total ?? "?"}`,
            };
        case "writing":
            return { percent: 95, text: "Writing vectors to Supabase..." };
        case "done":
            return { percent: 100, text: "Knowledge base ready." };
        default:
            return { percent: 0, text: "" };
    }
}

function showIndexedSite(site) {
    if (!site) return;
    siteInfo.classList.remove("hidden");
    siteInfo.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = site.site_title || site.site_url;
    siteInfo.appendChild(strong);
    siteInfo.append(
        ` - ${site.page_count} page${site.page_count === 1 ? "" : "s"} rendered, ` +
        `${site.chunk_count} chunks embedded into Supabase.`
    );
}

urlForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const url = urlInput.value.trim();
    if (!url) return;

    indexBtn.disabled = true;
    urlInput.disabled = true;
    siteInfo.classList.add("hidden");
    setProgress(2, "Contacting server...");
    brandOrb?.classList.add("status-busy");

    try {
        const res = await fetch("/api/index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, maxPages: Number(maxPagesInput.value) || 12 }),
        });

        const started = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(started.error || `Request failed with status ${res.status}`);
        }

        const targetUrl = started.url;

        // Poll until this job reports done or error. Progress lives server-side
        // so a page refresh mid-index does not lose it.
        while (true) {
            await new Promise((r) => setTimeout(r, 800));

            const statusRes = await fetch("/api/status");
            const status = await statusRes.json();
            const job = (status.jobs || []).find((j) => j.url === targetUrl);

            renderSites(status.sites, status.stats);
            if (!job) continue;

            if (job.phase === "error") throw new Error(job.error || "Indexing failed");

            const { percent, text } = describeProgress(job);
            setProgress(percent, text);

            if (!job.active && (job.phase === "done" || job.phase === "cached")) {
                const site = (status.sites || []).find((s) => s.site_url === targetUrl);
                showIndexedSite(site);
                addMessage(
                    "bot",
                    `Indexed "${site?.site_title || targetUrl}". It is now part of the corpus - ` +
                    "ask me anything and I will search every indexed site."
                );
                urlInput.value = "";
                await checkHealth();
                break;
            }
        }
    } catch (error) {
        setProgress(0, "");
        progressWrap.classList.add("hidden");
        addMessage("error", `Indexing failed: ${error.message}`);
    } finally {
        indexBtn.disabled = false;
        urlInput.disabled = false;
        brandOrb?.classList.remove("status-busy");
        await loadSites();
    }
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const question = chatText.value.trim();
    if (!question) return;

    chatText.value = "";
    addMessage("user", question);
    setChatEnabled(false);
    brandOrb?.classList.add("status-thinking");

    let typing = addTyping();
    let answerBubble = null;
    let answerText = "";

    try {
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question, history }),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Request failed with status ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalData = null;

        const handleLine = (line) => {
            if (!line.trim()) return;
            let data;
            try {
                data = JSON.parse(line);
            } catch {
                return;
            }
            if (data.error) throw new Error(data.error);

            if (data.token) {
                if (!answerBubble) {
                    typing.remove();
                    typing = null;
                    answerBubble = makeMessage("bot").bubble;
                    answerBubble.classList.add("streaming");
                }
                answerText += data.token;
                answerBubble.textContent = answerText;
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            if (data.done) finalData = data;
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
        }
        if (buffer.trim()) handleLine(buffer);

        if (typing) typing.remove();

        const answer = finalData?.answer ?? answerText;
        if (!answerBubble) {
            // No tokens streamed - a refusal short-circuits before generation.
            addMessage("bot", answer, finalData?.sources);
        } else {
            answerBubble.classList.remove("streaming");
            answerBubble.textContent = answer;
            if (finalData?.sources?.length) appendSources(answerBubble, finalData.sources);
        }

        // Refusals are left out of history so they cannot anchor later turns.
        if (!finalData?.refusal) {
            history.push({ role: "user", content: question });
            history.push({ role: "assistant", content: answer });
            while (history.length > 6) history.shift();
        }
    } catch (error) {
        if (typing) typing.remove();
        if (answerBubble) answerBubble.classList.remove("streaming");
        addMessage("error", `Something went wrong: ${error.message}`);
    } finally {
        setChatEnabled(true);
        chatText.focus();
        brandOrb?.classList.remove("status-thinking");
    }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

checkHealth();
loadSites();
setInterval(checkHealth, 15000);
