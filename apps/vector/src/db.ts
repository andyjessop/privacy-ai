import postgres from "postgres";
import { logger } from "../../../packages/logger/src/logger";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ai_api_dev";

export const sql = postgres(DATABASE_URL, {
  onnotice: () => {}, // Suppress notices
});

export async function initDb() {
  logger.info("Initializing database...");
  try {
    // Enable pgvector extension
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;

    // Create vectors table
    // Cloudflare Vectorize uses: id, values (vector), metadata (json)
    // We will use: id (text PK), values (vector), metadata (jsonb)
    // Dimension defaults to 1536 (OpenAI), but we should probably make it configurable or dynamic.
    // For now, let's assume 1536 as it's standard for embeddings.
    const dim = parseInt(process.env.VECTOR_DIMENSION || "1536");
    
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
      )
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
