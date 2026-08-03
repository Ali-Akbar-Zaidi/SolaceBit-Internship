# Website RAG Chatbot

A retrieval-augmented chatbot that answers questions from websites you index yourself. Paste a URL, it renders and stores the pages, and questions are answered only from that content — anything outside it is refused.

Puppeteer for scraping, tiktoken for chunking, Supabase pgvector for storage, local Ollama for inference. No prefetched corpus: you build it.

## How it works

**Indexing** — Puppeteer renders each page in real Chromium, so JavaScript-driven content is captured. Navigation, cookie notices, tables of contents and bibliography listings are stripped. The remaining prose is split into token-measured chunks, embedded, and written to Postgres.

**Answering** — the question is embedded and matched against every indexed site at once. Retrieved passages are handed to the model with instructions to quote them rather than explain the topic. If the corpus does not cover the question, the model is never called.

## Why questions get refused

This is the part most RAG demos get wrong, so it is worth stating plainly: **cosine similarity alone cannot decide relevance.** Measured against a Wikipedia article on the Indian Rebellion of 1857:

| question | best score | verdict |
|---|---|---|
| `what was the Indian Rebellion of 1857` | 0.765 | genuine |
| `who were the sepoys` | 0.651 | genuine |
| `what was the war of lalalala land` | **0.603** | nonsense |
| `what is the current price of Bitcoin` | 0.459 | off topic |

Nonsense scores 0.603 because "war" genuinely sits near "rebellion" in embedding space — only 0.048 below a real question. A 0.62 threshold would work on this corpus and reject *every* real question on another whose genuine matches peak at 0.53.

So relevance is decided in three layers:

1. **Absolute floor** (`RETRIEVAL_MIN_SCORE`, low by design) — rejects a question with no match anywhere.
2. **Relative cutoff** (`RETRIEVAL_RELATIVE_CUTOFF`) — keeps chunks near the best hit, adapting to whatever the corpus scores.
3. **Lexical gate** (`GROUNDING_MIN_TERM_RATIO`) — the question's distinctive words must actually appear in the retrieved text. `lalalala` appears nowhere, so it is refused regardless of score.

Prefix matching keeps plurals and inflections working, and only a fraction of terms is required, so paraphrases still answer.

## Prerequisites

- **Node.js 20+**
- **Ollama** with two models pulled:
  ```bash
  ollama pull llama3.2:1b
  ollama pull nomic-embed-text
  ```
- **Supabase** project (free tier is fine)

## Setup

```bash
npm install
cp .env.example .env     # then fill in DATABASE_URL
npm run migrate          # creates tables, pgvector, match_chunks()
npm start                # http://localhost:3000
```

`DATABASE_URL` must be the **connection pooler** string from *Supabase → Project Settings → Database → Connection pooling*. Server-side writes go through the Postgres role, not the publishable API key — that key is RLS-restricted and cannot write embeddings.

Every other setting in `.env.example` has a working default and is documented inline.

## Usage

Paste a URL in the UI, set a page limit, and click **Build Knowledge Base**. Sites **stack**: each one you add joins the corpus, and every question searches all of them. The panel lists what is indexed and lets you remove entries.

```bash
npm run cli                        # chat against everything indexed
npm run cli https://example.com    # index a site, then chat
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Ollama + database status, corpus stats |
| GET | `/api/sites` | List knowledge bases |
| GET | `/api/sites/:id` | Pages within one knowledge base |
| POST | `/api/index` | `{ url, maxPages? }` — starts indexing |
| GET | `/api/status` | Progress of running jobs |
| POST | `/api/chat` | `{ question, history? }` — streams NDJSON |
| DELETE | `/api/sites/:id` | Remove a knowledge base |

## Performance

Measured on a 12th-gen i5, CPU-only, with `llama3.2:1b`:

| | |
|---|---|
| refusal (no model call) | ~1.4s |
| answered question, first token | ~8s |
| indexing | ~4-6s per page |

Prompt prefill runs at 90-240 tok/s and **is** the bottleneck. Thread count barely matters (8 threads: 97 tok/s vs 90 default), so the lever is context size: `CHUNK_TOKENS`, `RETRIEVAL_TOP_K` and `RETRIEVAL_MAX_TOKENS`. Run `npm run diagnose` to see the breakdown on your own machine, or `node scripts/bench.js` to measure prefill directly.

For better synthesis on broad questions, set `CHAT_MODEL=llama3:latest` and expect ~40s to first token instead of ~8s.

## Project structure

```
src/
├── scraper/
│   ├── scraper.js          Puppeteer renderer + DOM text extraction
│   └── crawler.js          Same-origin BFS; filters site machinery
├── processing/
│   ├── cleaner.js          Boilerplate, cookie notices, TOC removal
│   └── chunker.js          tiktoken chunking + listing/prose filters
├── llm/ollama.js           Embeddings (L2-normalised) + streaming chat
├── vectorstore/            pgvector search, relative cutoff, token budget
├── rag/
│   ├── prompt.js           Extract-not-explain prompt
│   └── pipeline.js         Indexing, retrieval, relevance gate, refusal
├── db/client.js            Pooled Postgres, migrations, health
└── server/server.js        Express API + static UI

db/schema.sql               Tables, HNSW index, match_chunks()
scripts/                    migrate, reindex, diagnose, bench, tests
public/                     UI
```

## Testing

```bash
npm test                # 8 suites: unit + integration
npm run diagnose        # latency and grounding on the live corpus
node scripts/reindex.js # rebuild after changing chunking settings
```

Unit suites (chunker, cleaner, listing filter, boilerplate filter, crawler link filter) need nothing external. Integration suites need Ollama, Supabase and at least one indexed site, and are skipped with a message when unavailable rather than reported as failures.

**Re-index after changing `CHUNK_TOKENS`, the cleaner or the chunk filters.** Stored chunks are a product of the settings that were active when they were written.

## Troubleshooting

**"Ollama is not reachable"** — `ollama serve`, then pull both models.

**"Database schema incomplete"** — `npm run migrate`.

**Legitimate questions being refused** — lower `GROUNDING_MIN_TERM_RATIO`. The gate is lexical, so a question phrased entirely in synonyms of the source text can be rejected.

**Answers quote instead of summarising** — a `llama3.2:1b` limitation on broad questions, not a retrieval fault. Specific questions produce clean prose; `llama3:latest` synthesises better but is far slower.

**Chromium download blocked**
```bash
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install
# then set PUPPETEER_EXECUTABLE_PATH to an existing Chrome
```

## License

ISC — Ali Akbar Zaidi, SolaceBit AI/ML internship.
