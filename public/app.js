/**
 * SiteSage UI logic:
 * - health badge (is Ollama up?)
 * - build knowledge base (POST /api/index, then poll /api/status)
 * - chat with LIVE token streaming (reads the NDJSON stream from /api/chat)
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

// Recent conversation turns sent to the server so follow-ups work.
const history = [];

const BOT_AVATAR_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M8 12h.01M16 12h.01M9 16h6"/></svg>';

// ---------------------------------------------------------------------------
// Helpers
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
        link.textContent = source.title || source.url;
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
    if (enabled) chatText.focus();
}

function setProgress(percent, text) {
    progressWrap.classList.remove("hidden");
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    progressText.textContent = text;
}

function showSiteInfo(site) {
    siteInfo.classList.remove("hidden");
    siteInfo.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = site.title || site.url;
    siteInfo.appendChild(strong);
    siteInfo.append(
        ` - ${site.pages.length} page${site.pages.length === 1 ? "" : "s"} crawled, ` +
        `${site.chunks} chunks embedded. Ready to chat.`
    );
}

// ---------------------------------------------------------------------------
// 3D motion: cursor-tracked tilt on the glass panels, a spotlight highlight,
// gentle parallax on the aurora, and the brand orb turning to face the
// cursor. All of this is skipped on touch devices (no hover) and respects
// prefers-reduced-motion via CSS.
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
        // Orb turns toward the cursor, like a snow globe tracking a hand.
        if (orbWrap) {
            const rect = orbWrap.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = (event.clientX - cx) / window.innerWidth;
            const dy = (event.clientY - cy) / window.innerHeight;
            orbWrap.style.transform = `rotateY(${dx * 26}deg) rotateX(${-dy * 26}deg)`;
        }
        // Background drifts a few px opposite the cursor for ambient depth.
        if (aurora) {
            const x = (event.clientX / window.innerWidth - 0.5) * -24;
            const y = (event.clientY / window.innerHeight - 0.5) * -24;
            document.documentElement.style.setProperty("--parallax-x", `${x}px`);
            document.documentElement.style.setProperty("--parallax-y", `${y}px`);
        }
    });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkHealth() {
    try {
        const res = await fetch("/api/health");
        const data = await res.json();

        if (data.ollama.ok) {
            healthDot.className = "health-dot ok";
            healthText.textContent = `Ollama ready (${data.models.chat})`;
        } else if (data.ollama.reachable) {
            healthDot.className = "health-dot bad";
            healthText.textContent = `Missing models: ${data.ollama.missing.join(", ")}`;
        } else {
            healthDot.className = "health-dot bad";
            healthText.textContent = "Ollama is not running";
        }
        brandOrb?.classList.toggle("status-bad", !data.ollama.ok);

        // Restore state if a site is already loaded (e.g. page refresh).
        if (data.siteLoaded && data.site && chatText.disabled) {
            showSiteInfo(data.site);
            setChatEnabled(true);
        }
    } catch {
        healthDot.className = "health-dot bad";
        healthText.textContent = "Server unreachable";
        brandOrb?.classList.add("status-bad");
    }
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function describeProgress(indexing) {
    const d = indexing.detail || {};
    switch (indexing.phase) {
        case "starting":
            return { percent: 3, text: "Starting..." };
        case "crawling":
            return {
                percent: 5 + (d.crawled / d.total) * 35,
                text: `Crawling pages... ${d.crawled}/${d.total} (${d.url || ""})`,
            };
        case "chunking":
            return { percent: 45, text: `Split content into ${d.chunks} chunks. Embedding next...` };
        case "embedding":
            return {
                percent: 45 + (d.done / d.total) * 50,
                text: `Embedding chunks... ${d.done}/${d.total}`,
            };
        case "done":
            return { percent: 100, text: d.cached ? "Loaded from cache." : "Knowledge base ready." };
        default:
            return { percent: 0, text: "" };
    }
}

async function pollStatus() {
    const res = await fetch("/api/status");
    const data = await res.json();
    const indexing = data.indexing;
    if (!indexing) return { done: false };

    if (indexing.phase === "error") {
        return { done: true, error: indexing.error };
    }

    const { percent, text } = describeProgress(indexing);
    setProgress(percent, text);

    if (!indexing.active && indexing.phase === "done") {
        return { done: true, site: data.site };
    }
    return { done: false };
}

urlForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const url = urlInput.value.trim();
    if (!url) return;

    indexBtn.disabled = true;
    urlInput.disabled = true;
    setChatEnabled(false);
    siteInfo.classList.add("hidden");
    setProgress(2, "Contacting server...");
    brandOrb?.classList.add("status-busy");

    try {
        const res = await fetch("/api/index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, maxPages: Number(maxPagesInput.value) || 8 }),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Request failed with status ${res.status}`);
        }

        // Poll for progress until indexing finishes or fails.
        while (true) {
            await new Promise((r) => setTimeout(r, 700));
            const status = await pollStatus();
            if (status.done) {
                if (status.error) throw new Error(status.error);
                showSiteInfo(status.site);
                history.length = 0;
                addMessage(
                    "bot",
                    `Knowledge base built for "${status.site.title || status.site.url}". Ask me anything about it.`
                );
                setChatEnabled(true);
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
    }
});

// ---------------------------------------------------------------------------
// Chat (streams the answer token by token)
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

        // Read the NDJSON stream: {token} lines, then {done, sources}.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalData = null;

        const handleLine = (line) => {
            if (!line.trim()) return;
            const data = JSON.parse(line);
            if (data.error) throw new Error(data.error);

            if (data.token) {
                if (!answerBubble) {
                    // First token arrived: swap the typing dots for a live bubble.
                    typing.remove();
                    typing = null;
                    const made = makeMessage("bot");
                    answerBubble = made.bubble;
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
            buffer = lines.pop();
            for (const line of lines) handleLine(line);
        }
        if (buffer.trim()) handleLine(buffer);

        if (typing) typing.remove();

        const answer = finalData?.answer ?? answerText;
        if (!answerBubble) {
            // No tokens streamed (e.g. "nothing found" shortcut answer).
            addMessage("bot", answer, finalData?.sources);
        } else {
            answerBubble.classList.remove("streaming");
            answerBubble.textContent = answer;
            if (finalData?.sources?.length) appendSources(answerBubble, finalData.sources);
        }

        history.push({ role: "user", content: question });
        history.push({ role: "assistant", content: answer });
        while (history.length > 6) history.shift();
    } catch (error) {
        if (typing) typing.remove();
        if (answerBubble) answerBubble.classList.remove("streaming");
        addMessage("error", `Something went wrong: ${error.message}`);
    } finally {
        setChatEnabled(true);
        brandOrb?.classList.remove("status-thinking");
    }
});

checkHealth();
setInterval(checkHealth, 15000);