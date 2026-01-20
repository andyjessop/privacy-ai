import {
    type InsertVectorsRequest,
    type QueryVectorsRequest,
    type DeleteMemoryRequest,
    type QueryResponse,
    type InsertResponse,
} from "@ai-api/vector-types";
import { logger } from "../../../../packages/logger/src/logger";

const VECTOR_API_URL = process.env.VECTOR_API_URL || "http://localhost:3001";

export class VectorService {
    private async request<T>(endpoint: string, body: any): Promise<T> {
        const response = await fetch(`${VECTOR_API_URL}${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`Vector service error [${endpoint}]:`, errorText);
            throw new Error(`Vector service failed: ${response.statusText} - ${errorText}`);
        }

        return response.json() as Promise<T>;
    }

    async insert(vectors: InsertVectorsRequest["vectors"], userId?: string): Promise<InsertResponse> {
        try {
            return await this.request<InsertResponse>("/insert", { vectors, userId });
        } catch (error) {
            logger.error("Failed to insert vectors:", error);
            throw error;
        }
    }

    async query(
        vector: number[],
        options: Partial<Omit<QueryVectorsRequest, "vector">> = {}
    ): Promise<QueryResponse> {
        try {
            // We need to ensure defaults are passed if the server expects them, 
            // or rely on server-side zod defaults if we send undefined?
            // Zod defaults apply when value is undefined.
            // So sending { vector, topK: undefined } is fine.
            return await this.request<QueryResponse>("/query", {
                vector,
                ...options,
            });
        } catch (error) {
            logger.error("Failed to query vectors:", error);
            throw error;
        }
    }

    async deleteMemory(userId: string, vectorId: string, reason?: string): Promise<void> {
        try {
            await this.request("/delete-memory", { userId, vectorId, reason });
        } catch (error) {
            logger.error("Failed to delete memory:", error);
            throw error;
        }
    }
}

export const vectorService = new VectorService();
