import { Hono } from "hono";
import type { Sql } from "postgres";
import { logger } from "../../../packages/logger/src/logger";
import { initDb, sql } from "./db";

const app = new Hono();



// Initialize DB on startup
// Note: In production, might want to do this separately or handle async startup better.
// initDb().catch(logger.error); // Moved to bottom

import {
  DeleteMemoryRequestSchema,
  DeleteVectorsRequestSchema,
  GetVectorsRequestSchema,
  InsertVectorsRequestSchema,
  QueryVectorsRequestSchema,
  UpsertVectorsRequestSchema,
  type VectorMatch,
} from "@ai-api/vector-types";
import { zValidator } from "@hono/zod-validator";

// ... (initDb call commented out)

// 1. INSERT / UPSERT
// Cloudflare Vectorize: insert() and upsert()
// We'll mimic this. Payload: { vectors: [ { id, values, metadata } ] }
// Response: { count: number, ids: string[] }

app.post(
  "/insert",
  zValidator("json", InsertVectorsRequestSchema),
  async (c) => {
    try {
      const { vectors, userId } = c.req.valid("json");

      // Insert logic
      const insertedIds: string[] = [];

      // Use transaction if userId is present to ensure consistency
      await sql.begin(async (t: unknown) => {
        const txn = t as Sql;
        for (const v of vectors) {
          const result = await txn`
          INSERT INTO vectors (id, values, metadata)
          VALUES (${v.id}, ${JSON.stringify(v.values)}, ${sql.json(v.metadata || {})})
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
          if (result.length > 0 && v.id) {
            insertedIds.push(v.id);
            if (userId) {
              await txn`
                 INSERT INTO users_vectors (user_id, vector_id)
                 VALUES (${userId}, ${v.id})
                 ON CONFLICT (user_id, vector_id) DO NOTHING
               `;
            }
          } else if (v.id && userId) {
            // If vector already exists, we might still need to link it to the user
            await txn`
                 INSERT INTO users_vectors (user_id, vector_id)
                 VALUES (${userId}, ${v.id})
                 ON CONFLICT (user_id, vector_id) DO NOTHING
               `;
            // We should probably count this as "inserted" for the caller if they care about the link?
            // The original spec says "count: number" normally refers to new vectors. 
            // For now, let's only push to insertedIds if the vector was new, or maybe we don't change that behavior.
            // Re-reading spec: "For each new memory: ... Insert into users_vectors".
          }
        }
      });

      return c.json({ count: insertedIds.length, ids: insertedIds });
    } catch (error) {
      logger.error("Insert error:", error);
      return c.json({ error: (error as Error).message }, 500);
    }
  },
);

app.post(
  "/upsert",
  zValidator("json", UpsertVectorsRequestSchema),
  async (c) => {
    try {
      const { vectors, userId } = c.req.valid("json");

      const upsertedIds: string[] = [];
      await sql.begin(async (t: unknown) => {
        const txn = t as Sql;
        for (const v of vectors) {
          // Prepare metadata as JSON object
          const metadata = v.metadata || {};

          const result = await txn`
            INSERT INTO vectors (id, values, metadata)
            VALUES (${v.id}, ${JSON.stringify(v.values)}, ${sql.json(metadata)})
            ON CONFLICT (id) DO UPDATE
            SET values = EXCLUDED.values, metadata = EXCLUDED.metadata
            RETURNING id
          `;
          if (result.length > 0 && v.id) {
            upsertedIds.push(v.id);
            if (userId) {
              await txn`
                        INSERT INTO users_vectors (user_id, vector_id)
                        VALUES (${userId}, ${v.id})
                        ON CONFLICT (user_id, vector_id) DO NOTHING
                    `;
            }
          } else if (v.id && userId) {
            // Vector update didn't return ID possibly? (Shouldn't happen with DO UPDATE RETURNING)
            // But just in case, ensure link
            await txn`
                    INSERT INTO users_vectors (user_id, vector_id)
                    VALUES (${userId}, ${v.id})
                    ON CONFLICT (user_id, vector_id) DO NOTHING
                 `;
          }
        }
      });

      return c.json({ count: upsertedIds.length, ids: upsertedIds });
    } catch (error) {
      logger.error("Upsert error:", error);
      return c.json({ error: (error as Error).message }, 500);
    }
  },
);

// 2. QUERY
// Payload: { vector: number[], topK?: number, returnMetadata?: boolean }
// Response: { matches: [ { id, score, values?, metadata? } ] }

app.post("/query", zValidator("json", QueryVectorsRequestSchema), async (c) => {
  try {
    const { vector, topK, returnValues, returnMetadata, userId } = c.req.valid("json");

    let matches: VectorMatch[] = [];
    if (userId) {
      // Query joined with users_vectors
      const results = await sql`
          SELECT 
            v.id, 
            (1 - (v.values <=> ${JSON.stringify(vector)})) as score
            ${returnValues ? sql`, v.values` : sql``}
            ${returnMetadata ? sql`, v.metadata` : sql``}
          FROM vectors v
          JOIN users_vectors uv ON v.id = uv.vector_id
          WHERE uv.user_id = ${userId}
          ORDER BY v.values <=> ${JSON.stringify(vector)}
          LIMIT ${topK}
        `;
      matches = results as unknown as VectorMatch[];
    } else {
      // Original query (global search - might want to restrict this in production?)
      // For now, if no userId, we search everything.
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
      matches = results as unknown as VectorMatch[];
    }

    // Map results to shape
    const mappedMatches = matches.map((r) => ({
      id: r.id,
      score: r.score,
      values: returnValues
        ? (typeof (r.values as unknown) === "string" ? JSON.parse(r.values as unknown as string) : r.values)
        : undefined,
      metadata: returnMetadata ? r.metadata : undefined,
    }));

    return c.json({ matches: mappedMatches });
  } catch (error) {
    logger.error("Query error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

// 2.5 DELETE MEMORY (Logical delete for user)
app.post(
  "/delete-memory",
  zValidator("json", DeleteMemoryRequestSchema),
  async (c) => {
    try {
      const { userId, vectorId, reason } = c.req.valid("json");

      await sql.begin(async (t: unknown) => {
        const txn = t as Sql;
        // 1. Remove link
        const deleted = await txn`
            DELETE FROM users_vectors
            WHERE user_id = ${userId} AND vector_id = ${vectorId}
            RETURNING vector_id
        `;

        if (deleted.length > 0) {
          // 2. Log update
          await txn`
                INSERT INTO memory_updates (user_id, old_vector_id, reason)
                VALUES (${userId}, ${vectorId}, ${reason || "manual_deletion"})
            `;
        }
      });

      return c.json({ success: true, deleted: true });
    } catch (error) {
      logger.error("Delete memory error:", error);
      return c.json({ error: (error as Error).message }, 500);
    }
  }
);

// 3. DELETE
app.post(
  "/deleteByIds",
  zValidator("json", DeleteVectorsRequestSchema),
  async (c) => {
    try {
      const { ids } = c.req.valid("json");

      const result = await sql`
            DELETE FROM vectors
            WHERE id IN ${sql(ids)}
            RETURNING id
        `;

      return c.json({ count: result.length, ids: result.map((r) => r.id) });
    } catch (error) {
      logger.error("Delete error:", error);
      return c.json({ error: (error as Error).message }, 500);
    }
  },
);

// 4. GET BY ID
app.post(
  "/getByIds",
  zValidator("json", GetVectorsRequestSchema),
  async (c) => {
    try {
      const { ids } = c.req.valid("json");

      const results = await sql`
            SELECT id, values, metadata
            FROM vectors
            WHERE id IN ${sql(ids)}
        `;

      // Parse pgvector string format "[1,2,3]" if necessary
      const parsedResults = results.map((r) => ({
        ...r,
        values: typeof r.values === "string" ? JSON.parse(r.values) : r.values,
      }));

      return c.json(parsedResults);
    } catch (error) {
      logger.error("GetByIds error:", error);
      return c.json({ error: (error as Error).message }, 500);
    }
  },
);

const port = process.env.PORT || 3001;

// Only start the server if this file is run directly
if (import.meta.main) {
  initDb().catch(logger.error);
  logger.info(`Vector service running on port ${port}`);
}

export default {
  port,
  fetch: app.fetch,
};

export { app };
