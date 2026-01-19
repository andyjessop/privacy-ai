import { z } from "zod";

// --- Base Types ---

export const VectorSchema = z.object({
  id: z.string(),
  values: z.array(z.number()),
  metadata: z.record(z.any()).optional(),
});

export type Vector = z.infer<typeof VectorSchema>;

export const VectorMatchSchema = VectorSchema.extend({
    score: z.number(),
});

export type VectorMatch = z.infer<typeof VectorMatchSchema>;

// --- Request Schemas ---

export const InsertVectorsRequestSchema = z.object({
  vectors: z.array(VectorSchema),
});

export type InsertVectorsRequest = z.infer<typeof InsertVectorsRequestSchema>;

export const UpsertVectorsRequestSchema = InsertVectorsRequestSchema;
export type UpsertVectorsRequest = z.infer<typeof UpsertVectorsRequestSchema>;

export const QueryVectorsRequestSchema = z.object({
  vector: z.array(z.number()),
  topK: z.number().optional().default(5),
  returnValues: z.boolean().optional().default(false),
  returnMetadata: z.boolean().optional().default(false),
});

export type QueryVectorsRequest = z.infer<typeof QueryVectorsRequestSchema>;

export const DeleteVectorsRequestSchema = z.object({
    ids: z.array(z.string()),
});

export type DeleteVectorsRequest = z.infer<typeof DeleteVectorsRequestSchema>;

export const GetVectorsRequestSchema = z.object({
    ids: z.array(z.string()),
});

export type GetVectorsRequest = z.infer<typeof GetVectorsRequestSchema>;

// --- Response Schemas ---

export const InsertResponseSchema = z.object({
    count: z.number(),
    ids: z.array(z.string()),
});
export type InsertResponse = z.infer<typeof InsertResponseSchema>;

export const UpsertResponseSchema = InsertResponseSchema;
export type UpsertResponse = z.infer<typeof UpsertResponseSchema>;

export const QueryResponseSchema = z.object({
    matches: z.array(VectorMatchSchema),
});
export type QueryResponse = z.infer<typeof QueryResponseSchema>;

export const DeleteResponseSchema = InsertResponseSchema;
export type DeleteResponse = z.infer<typeof DeleteResponseSchema>;
