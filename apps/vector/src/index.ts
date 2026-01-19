import { Hono } from "hono";
import { logger } from "../../../packages/logger/src/logger";
import { initDb, sql } from "./db";

const app = new Hono();

// Initialize DB on startup
// Note: In production, might want to do this separately or handle async startup better.
initDb().catch(logger.error);

// 1. INSERT / UPSERT
// Cloudflare Vectorize: insert() and upsert()
// We'll mimic this. Payload: { vectors: [ { id, values, metadata } ] }
// Response: { count: number, ids: string[] }

app.post("/insert", async (c) => {
  try {
    const { vectors } = await c.req.json() as { vectors: any[] };
    if (!vectors || !Array.isArray(vectors) || vectors.length === 0) {
      return c.json({ error: "Invalid payload" }, 400);
    }

    // Insert logic
    const insertedIds = [];
    for (const v of vectors) {
      await sql`
        INSERT INTO vectors (id, values, metadata)
        VALUES (${v.id}, ${JSON.stringify(v.values)}, ${v.metadata || {}})
        ON CONFLICT (id) DO NOTHING
      `;
      insertedIds.push(v.id);
    }

    return c.json({ count: insertedIds.length, ids: insertedIds });
  } catch (error) {
    logger.error("Insert error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.post("/upsert", async (c) => {
  try {
    const { vectors } = await c.req.json() as { vectors: any[] };
    if (!vectors || !Array.isArray(vectors) || vectors.length === 0) {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const upsertedIds = [];
    for (const v of vectors) {
        // Prepare metadata as JSON object
        const metadata = v.metadata || {};
        
      await sql`
        INSERT INTO vectors (id, values, metadata)
        VALUES (${v.id}, ${JSON.stringify(v.values)}, ${metadata})
        ON CONFLICT (id) DO UPDATE
        SET values = EXCLUDED.values, metadata = EXCLUDED.metadata
      `;
      upsertedIds.push(v.id);
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

app.post("/query", async (c) => {
  try {
    const body = await c.req.json() as { vector: number[], topK?: number, returnValues?: boolean, returnMetadata?: boolean };
    const { vector, topK = 5, returnValues = false, returnMetadata = false } = body;

    if (!vector || !Array.isArray(vector)) {
      return c.json({ error: "Invalid vector" }, 400);
    }

    // Cosine similarity in pgvector is standardly 1 - (a <=> b) if normalized, 
    // or just use <=> operator for distance and sort ASC.
    // Cloudflare returns "score" where higher is better (similarity).
    // pgvector <=> operator returns cosine distance (0 is identical, 2 is opposite).
    // So distinct = 1 - score => score = 1 - distance.
    
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
      values: returnValues ? JSON.parse(r.values) : undefined, // pgvector returns string representation? likely.
      metadata: returnMetadata ? r.metadata : undefined
    }));

    return c.json({ matches });
  } catch (error) {
    logger.error("Query error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

// 3. DELETE
// Payload: { ids: string[] }
// Response: { count: number, ids: string[] }

app.post("/deleteByIds", async (c) => {
    try {
        const { ids } = await c.req.json() as { ids: string[] };
         if (!ids || !Array.isArray(ids)) {
            return c.json({ error: "Invalid ids" }, 400);
        }

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
// Payload: { ids: string[] } (This is usually not standard Vectorize, but GetByIds is common)
// Cloudflare has `getByIds`
app.post("/getByIds", async (c) => {
     try {
        const { ids } = await c.req.json() as { ids: string[] };
         if (!ids || !Array.isArray(ids)) {
            return c.json({ error: "Invalid ids" }, 400);
        }
        
        const results = await sql`
            SELECT id, values, metadata
            FROM vectors
            WHERE id IN ${sql(ids)}
        `;

        return c.json(results);

    } catch (error) {
        logger.error("GetByIds error:", error);
         return c.json({ error: (error as Error).message }, 500);
    }
});

const port = process.env.PORT || 3001;

export default {
    port,
    fetch: app.fetch,
}

logger.info(`Vector service running on port ${port}`);
