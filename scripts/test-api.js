const BASE = process.env.BASE_URL || "http://localhost:3000";

/**
 * Verifies the HTTP layer: NDJSON streaming, grounded answering and refusal.
 *
 * The on-topic question is derived from whatever is currently indexed, so this
 * works against any corpus rather than assuming a particular site.
 */

async function ask(question) {
    const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let tokens = 0;
    let firstTokenMs = null;
    let final = null;
    const t0 = Date.now();

    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            const evt = JSON.parse(line);
            if (evt.error) throw new Error(evt.error);
            if (evt.token) {
                tokens++;
                if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            }
            if (evt.done) final = evt;
        }
    }

    return { ...final, tokens, firstTokenMs, totalMs: Date.now() - t0 };
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (!health.stats || health.stats.ready_sites === 0) {
    console.error("No knowledge bases indexed. Index a site first.");
    process.exit(1);
}

const sites = await fetch(`${BASE}/api/sites`).then((r) => r.json());
const topic = sites.sites.find((s) => s.status === "ready")?.site_title ?? "this site";

const cases = [
    { q: `What is ${topic} about?`, expect: "answer" },
    { q: "What is the current price of Bitcoin in US dollars?", expect: "refuse" },
];

let failures = 0;

for (const { q, expect } of cases) {
    const r = await ask(q);
    const ok = expect === "refuse" ? r.refusal : !r.refusal && r.sources.length > 0;
    if (!ok) failures++;

    console.log(`\n${ok ? "PASS" : "FAIL"} [${expect}] ${q}`);
    console.log(
        `  firstToken=${r.firstTokenMs ?? "-"}ms total=${r.totalMs}ms ` +
        `streamed=${r.tokens} refusal=${r.refusal} sources=${r.sources.length}`
    );
    console.log(`  ${r.answer.slice(0, 240)}`);
}

console.log(failures === 0 ? "\nAPI E2E: PASS" : `\nAPI E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
