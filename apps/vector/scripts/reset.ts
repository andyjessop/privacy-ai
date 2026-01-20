
import { sql, initDb } from "../src/db";

async function main() {
    console.log("Dropping tables...");
    await sql`DROP TABLE IF EXISTS users_vectors CASCADE`;
    await sql`DROP TABLE IF EXISTS memory_updates CASCADE`;
    await sql`DROP TABLE IF EXISTS vectors CASCADE`;
    console.log("Tables dropped.");

    console.log("Recreating tables...");
    await initDb();
    console.log("Tables recreated.");

    process.exit(0);
}

main().catch(console.error);
