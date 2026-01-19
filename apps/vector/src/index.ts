import { Hono } from "hono";
import { logger } from "../../../packages/logger/src/logger";
import { initDb, sql } from "./db";

const app = new Hono();

// Initialize DB on startup
// Note: In production, might want to do this separately or handle async startup better.
// initDb().catch(logger.error); // Moved to bottom

import { zValidator } from "@hono/zod-validator";
import { 
    InsertVectorsRequestSchema, 
    UpsertVectorsRequestSchema,
    QueryVectorsRequestSchema, 
    DeleteVectorsRequestSchema, 
    GetVectorsRequestSchema 
} from "@ai-api/vector-types";

// ... (initDb call commented out)

// 1. INSERT / UPSERT
// Cloudflare Vectorize: insert() and upsert()
// We'll mimic this. Payload: { vectors: [ { id, values, metadata } ] }
// Response: { count: number, ids: string[] }

app.post("/insert", zValidator("json", InsertVectorsRequestSchema), async (c) => {
  try {
    const { vectors } = c.req.valid("json");
    
    // Insert logic
    const insertedIds: string[] = [];
    for (const v of vectors) {
      const result = await sql`
        INSERT INTO vectors (id, values, metadata)
        VALUES (${v.id}, ${JSON.stringify(v.values)}, ${sql.json(v.metadata || {})})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) insertedIds.push(v.id!); // v.id is string
    }

    return c.json({ count: insertedIds.length, ids: insertedIds });
  } catch (error) {
    logger.error("Insert error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.post("/upsert", zValidator("json", UpsertVectorsRequestSchema), async (c) => {
  try {
    const { vectors } = c.req.valid("json");

    const upsertedIds: string[] = [];
    for (const v of vectors) {
        // Prepare metadata as JSON object
        const metadata = v.metadata || {};
        
      const result = await sql`
        INSERT INTO vectors (id, values, metadata)
        VALUES (${v.id}, ${JSON.stringify(v.values)}, ${sql.json(v.metadata || {})})
        ON CONFLICT (id) DO UPDATE
        SET values = EXCLUDED.values, metadata = EXCLUDED.metadata
        RETURNING id
      `;
      if (result.length > 0) upsertedIds.push(v.id!);
    }

    return c.json({ count: upsertedIds.length, ids: upsertedIds });
  } catch (error) {
    logger.error("Upsert error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});


// 2. QUERY
// Payload: { vector: number[], topK?: number, returnMetadata?: boolean }
// Response: { matches: [ { id, score, values?, metadata? } ] }

app.post("/query", zValidator("json", QueryVectorsRequestSchema), async (c) => {
  try {
    const { vector, topK, returnValues, returnMetadata } = c.req.valid("json");

     // topK defaults handled by Zod or below? Zod schema handles defaults.
     // Default values in destructured assignment not strictly needed if Zod has .default().
     // But `topK` in schema is optional with default.

    // Cosine similarity...
    const results = await sql`
      SELECT 
        id, 
        (1 - (values <=> ${JSON.stringify(vector)})) as score
        ${returnValues ? sql`, values` : sql``}
        ${returnMetadata ? sql`, metadata` : sql``}
      FROM vectors
      ORDER BY values <=> ${JSON.stringify(vector)}
      LIMIT ${topK}
    `;

    // Map results to shape
    const matches = results.map(r => ({
      id: r.id,
      score: r.score,
      values: returnValues ? JSON.parse(r.values) : undefined,
      metadata: returnMetadata ? r.metadata : undefined
    }));

    return c.json({ matches });
  } catch (error) {
    logger.error("Query error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

// 3. DELETE
app.post("/deleteByIds", zValidator("json", DeleteVectorsRequestSchema), async (c) => {
    try {
        const { ids } = c.req.valid("json");

        const result = await sql`
            DELETE FROM vectors
            WHERE id IN ${sql(ids)}
            RETURNING id
        `;

        return c.json({ count: result.length, ids: result.map(r => r.id) });

    } catch (error) {
        logger.error("Delete error:", error);
        return c.json({ error: (error as Error).message }, 500);
    }
});


// 4. GET BY ID
app.post("/getByIds", zValidator("json", GetVectorsRequestSchema), async (c) => {
     try {
        const { ids } = c.req.valid("json");
        
        const results = await sql`
            SELECT id, values, metadata
            FROM vectors
            WHERE id IN ${sql(ids)}
        `;

        // Parse pgvector string format "[1,2,3]" if necessary
        const parsedResults = results.map(r => ({
            ...r,
            values: typeof r.values === 'string' ? JSON.parse(r.values) : r.values
        }));

        return c.json(parsedResults);

    } catch (error) {
        logger.error("GetByIds error:", error);
         return c.json({ error: (error as Error).message }, 500);
    }
});

const port = process.env.PORT || 3001;

// Only start the server if this file is run directly
if (import.meta.main) {
    initDb().catch(logger.error);
    logger.info(`Vector service running on port ${port}`);
}

export default {
    port,
    fetch: app.fetch,
}

export { app };
