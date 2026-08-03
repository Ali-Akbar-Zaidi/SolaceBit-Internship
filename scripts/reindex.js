import "dotenv/config";

import { indexWebsite, cleanup } from "../src/rag/pipeline.js";
import { listKnowledgeBases } from "../src/vectorstore/vectorStore.js";
import { closePool } from "../src/db/client.js";

/**
 * Rebuilds one or all knowledge bases with the current chunking settings.
 *
 *   node scripts/reindex.js                 - every indexed site
 *   node scripts/reindex.js <url>           - one site
 *   node scripts/reindex.js <url> <pages>   - one site, page limit
 *
 * Needed after changing CHUNK_TOKENS, the cleaner or the chunk filter, since
 * stored chunks are a product of whatever settings were active when they were
 * written.
 */

const target = process.argv[2] || null;
const maxPages = Math.min(Math.max(Number(process.argv[3]) || 8, 1), 30);

const kbs = await listKnowledgeBases();

// Every stored site is eligible, not just the ready ones. A site interrupted
// mid-index is left in the "indexing" state, and that is exactly the site most
// in need of rebuilding - skipping it would strand it permanently.
const sites = target ? [{ site_url: target }] : kbs;

if (sites.length === 0) {
    console.log("Nothing to re-index.");
    await closePool();
    process.exit(0);
}

console.log(`Re-indexing ${sites.length} site(s) at up to ${maxPages} pages each.\n`);

let ok = 0;
let failed = 0;

for (const site of sites) {
    process.stdout.write(`  ${site.site_url}\n`);
    try {
        await indexWebsite(site.site_url, {
            maxPages,
            useCache: false,
            onProgress: (u) => {
                if (u.phase === "crawling" && u.crawled) {
                    process.stdout.write(`    crawled ${u.crawled}/${u.total}\r`);
                } else if (u.phase === "embedding") {
                    process.stdout.write(`    embedded ${u.done}/${u.total}\r`);
                } else if (u.phase === "done") {
                    process.stdout.write(
                        `    done: ${u.kb.page_count} pages, ${u.kb.chunk_count} chunks\n`
                    );
                }
            },
        });
        ok++;
    } catch (error) {
        process.stdout.write(`    failed: ${error.message}\n`);
        failed++;
    }
}

console.log(`\nRe-indexed ${ok}, failed ${failed}.`);

cleanup();
await closePool();
