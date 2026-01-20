import postgres from "postgres";
import { logger } from "../../../packages/logger/src/logger";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/ai_api_dev";

export const sql = postgres(DATABASE_URL, {
  onnotice: () => { }, // Suppress notices
});

export async function initDb(retries = 5, delay = 1000) {
  logger.info("Initializing database...");
  for (let i = 0; i < retries; i++) {
    try {
      // Enable pgvector extension
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      break; // Success
    } catch (error) {
      if (i === retries - 1) {
        logger.error("Failed to initialize database after retries:", error);
        process.exit(1);
      }
      const code = (error as any).code;
      if (code === "57P03" || code === "ECONNREFUSED") {
        logger.warn(
          `Database not ready, retrying in ${delay}ms... (${i + 1}/${retries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }

  try {
    const dim = Number.parseInt(process.env.VECTOR_DIMENSION || "1024", 10);

    // Create vectors table
    // Cloudflare Vectorize uses: id, values (vector), metadata (json)
    // We will use: id (text PK), values (vector), metadata (jsonb)
    // Dimension defaults to 1536 (OpenAI), but we should probably make it configurable or dynamic.
    // For now, let's assume 1536 as it's standard for embeddings.

    // Check if we need to reset/re-init (optional, but good for dev iteration if schema changes)
    // For now, we will strictly create if not exists.
    // If you need to change dimension, you must drop the table manually or wipe the DB.

    // Note: Parameterizing 'vector(N)' in DDL doesn't work with standard parameter binding ($1).
    // We must inject the dimension directly.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        values vector(${dim}),
        metadata JSONB
      );

      CREATE TABLE IF NOT EXISTS users_vectors (
        user_id TEXT NOT NULL,
        vector_id TEXT NOT NULL REFERENCES vectors(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, vector_id)
      );

      CREATE TABLE IF NOT EXISTS memory_updates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        old_vector_id TEXT,
        new_vector_id TEXT,
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Index for faster queries (HNSW)
    // Note: Creating index might fail if no data, or if dim is different.
    // Usually best to create index after some data is inserted or if table is empty.
    // Using IF NOT EXISTS logic for index is slightly complex in raw SQL,
    // but we can try exception handling or checking pg_indexes.
    // For simplicity, we'll skip auto-index creation in this simple init for now,
    // or we can add it safely.

    logger.info("Database initialized successfully.");
  } catch (error) {
    logger.error("Failed to initialize database:", error);
    process.exit(1);
  }
}
