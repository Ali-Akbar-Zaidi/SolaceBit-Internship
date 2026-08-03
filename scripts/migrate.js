import "dotenv/config";

import { migrate, checkDatabase, closePool } from "../src/db/client.js";

/**
 * Applies db/schema.sql to the database in DATABASE_URL, then verifies that
 * every expected table and function exists. Safe to re-run.
 */
try {
    console.log("Applying schema...");
    await migrate();
    console.log("Schema applied.");

    const health = await checkDatabase();
    if (!health.ok) {
        console.error("Verification failed. Missing:", health.missing.join(", ") || health.error);
        process.exitCode = 1;
    } else {
        console.log("Verified:", health.version.split(" on ")[0]);
        console.log("All tables and match_chunks() present.");
    }
} catch (error) {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
} finally {
    await closePool().catch(() => { });
}
