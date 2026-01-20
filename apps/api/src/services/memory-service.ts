import { mistral } from "@ai-sdk/mistral";
import { generateObject, type CoreMessage } from "ai";
import { mistralEmbed } from "../utils/embedding"; // Need to check if this exists or create it
import { vectorService } from "./vector-service";
import { logger } from "../../../../packages/logger/src/logger";
import { z } from "zod";

// Draft prompt schemas
const ExtractedMemoriesSchema = z.object({
    memories: z.array(z.string()),
});

const ConflictResolutionSchema = z.object({
    action: z.enum(["add", "replace", "ignore"]),
    target_id: z.string().optional(),
    reason: z.string().optional(),
    fact: z.string(), // The fact being processed
});

const ConflictResolutionBatchSchema = z.object({
    decisions: z.array(ConflictResolutionSchema),
});

export class MemoryService {
    async processMemories(
        userId: string,
        userMessage: string,
        contextMessages: CoreMessage[]
    ) {
        try {
            logger.info(`[Memory] Processing for user ${userId}`);

            // 1. Extract Facts
            // We pass the validation/extraction prompt
            const { object: extracted } = await generateObject({
                model: mistral("mistral-small-latest"),
                schema: ExtractedMemoriesSchema,
                messages: [
                    {
                        role: "system",
                        content: `You are an expert memory archivist. Your goal is to extract new, permanent facts, preferences, or meaningful details about the user that should be remembered for future conversations.

Instructions:
1. Analyze the User Message for factual statements about the user's life, work, preferences, or state.
2. Ignore transient information (e.g., "Hello", "How are you?", "Write a poem", "I am testing this").
3. Extract facts as concise, standalone sentences or paragraphs (e.g., "User is a software engineer using Bun", "User prefers TypeScript"). Anything up to 500 words is fine.
4. Return a JSON object with a list of strings called 'memories'.
5. If no new information is found, return an empty list.`,
                    },
                    ...contextMessages.filter(m => m.role !== "tool"),
                    { role: "user", content: userMessage },
                ],
            });

            if (extracted.memories.length === 0) {
                logger.info("[Memory] No new facts extracted.");
                return;
            }

            logger.info(`[Memory] Extracted ${extracted.memories.length} potential memories:`, extracted.memories);

            // 2. Retrieval (to check for conflicts)
            // We embed the concatenated new memories to find relevant existing ones.
            // Or we could embed each, but that's expensive. 
            // Let's simplified: embed the first/primary memory or the whole block?
            // Better: Retrieve based on the User Message (which we likely already have from the request, but let's re-do or assume independent).
            // Actually, we should probably check against *all* recent memories or semantically similar ones.

            const combinedText = extracted.memories.join(" ");
            const embedding = await mistralEmbed(combinedText);
            const existing = await vectorService.query(embedding, { userId, topK: 10, returnMetadata: true });

            const existingMemoriesList = existing.matches.map(m => `[ID: ${m.id}] ${m.metadata?.content || ""}`).join("\n");

            // 3. De-duplication / Conflict Resolution
            const { object: resolution } = await generateObject({
                model: mistral("mistral-small-latest"),
                schema: ConflictResolutionBatchSchema,
                messages: [
                    {
                        role: "system",
                        content: `Compare the New Facts to Existing Memories.

Existing Memories:
${existingMemoriesList}

New Facts:
${JSON.stringify(extracted.memories)}

For each New Fact, determine if it:
1. Contradicts an existing memory (Action: "replace", target_id: existing_id)
2. Is strictly more specific/better than an existing memory (Action: "replace", target_id: existing_id)
3. Is already known/redundant (Action: "ignore")
4. Is new and unrelated (Action: "add")

Return a list of decisions.`,
                    },
                ],
            });

            // 4. Execute Actions
            for (const decision of resolution.decisions) {
                logger.info(`[Memory] Decision: ${decision.action} for "${decision.fact}"`);

                if (decision.action === "ignore") continue;

                if (decision.action === "replace" && decision.target_id) {
                    await vectorService.deleteMemory(userId, decision.target_id, decision.reason || "Replaced by newer fact");
                }

                if (decision.action === "add" || decision.action === "replace") {
                    const id = crypto.randomUUID();
                    const vector = await mistralEmbed(decision.fact);

                    await vectorService.insert([
                        {
                            id,
                            values: vector,
                            metadata: {
                                content: decision.fact,
                                type: "memory",
                                created_at: new Date().toISOString()
                            }
                        }
                    ], userId);
                }
            }

        } catch (error) {
            logger.error("[Memory] Background process failed:", error);
        }
    }
}

export const memoryService = new MemoryService();
