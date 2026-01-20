import { mistral } from "@ai-sdk/mistral";
import { zValidator } from "@hono/zod-validator";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../../packages/logger/src/logger";

const app = new Hono();

// Middleware to log requests
app.use("*", async (c, next) => {
    logger.info(`[${c.req.method}] ${c.req.url}`);
    await next();
});

// GET /v1/models
app.get("/v1/models", (c) => {
    // Return a list of supported models.
    // OpenWebUI uses this to populate the model selector.
    // We can hardcode some Mistral models for now.
    const models = [
        {
            id: "mistral-small-latest",
            object: "model",
            created: Date.now(),
            owned_by: "mistralai",
        },
        {
            id: "mistral-medium-latest",
            object: "model",
            created: Date.now(),
            owned_by: "mistralai",
        },
        {
            id: "mistral-large-latest",
            object: "model",
            created: Date.now(),
            owned_by: "mistralai",
        },
    ];

    return c.json({ object: "list", data: models });
});

// Validates the OpenAI chat completion format (subset)
const ChatCompletionSchema = z
    .object({
        model: z.string(),
        messages: z.array(
            z.object({
                role: z.enum(["system", "user", "assistant", "tool"]),
                content: z.string().nullable().optional(),
                tool_call_id: z.string().optional(),
                tool_calls: z.array(z.any()).optional(),
            }).superRefine((data, ctx) => {
                if ((data.role === "user" || data.role === "system") && (!data.content || data.content.trim() === "")) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Content is required for user and system messages",
                        path: ["content"],
                    });
                }
                if (data.role === "tool" && !data.tool_call_id) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "tool_call_id is required for tool messages",
                        path: ["tool_call_id"],
                    });
                }
            }),
        ),
        stream: z.boolean().optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_tokens: z.number().optional().or(z.null()),
        metadata: z.record(z.any()).optional(),
    })
    .passthrough();

import { type CoreMessage } from "ai";
import { stream } from "hono/streaming";
import { mistralEmbed } from "./utils/embedding";
import { vectorService } from "./services/vector-service";
import { memoryService } from "./services/memory-service";

// POST /v1/chat/completions
app.post(
    "/v1/chat/completions",
    zValidator("json", ChatCompletionSchema),
    async (c) => {
        const body = c.req.valid("json");
        const headers = c.req.header();
        const userId = headers["x-openwebui-user-id"];

        const {
            model,
            messages,
            stream: isStream,
            temperature,
            top_p,
            max_tokens,
            metadata, // e.g. for user valves
        } = body;

        logger.info(`Chat request for model: ${model}, stream: ${isStream}`);
        if (metadata) {
            logger.info(`User Valves/Metadata: ${JSON.stringify(metadata)}`);
        }

        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) {
            logger.error("MISTRAL_API_KEY not found in environment");
            return c.json({ error: "Server misconfiguration: API key missing" }, 500);
        }

        let injectedSystemContext = "";

        // RAG Step 1: Retrieval
        const lastUserMessage = messages.slice().reverse().find(m => m.role === "user")?.content;

        let relevantMemories: string[] = [];

        if (userId && lastUserMessage) {
            try {
                logger.info(`[RAG] Retrieving memories for user ${userId}`);
                const embedding = await mistralEmbed(lastUserMessage);
                const results = await vectorService.query(embedding, { userId, topK: 10, returnMetadata: true });

                relevantMemories = results.matches
                    .filter(m => m.score > 0.65)
                    .map(m => m.metadata?.content)
                    .filter(Boolean);

                if (relevantMemories.length > 0) {
                    logger.info(`[RAG] Found ${relevantMemories.length} relevant memories.`);
                    injectedSystemContext = `\n\nExisting Memories (Facts about the user):\n${relevantMemories.map(m => `- ${m}`).join("\n")}\n`;
                }
            } catch (error) {
                logger.error("[RAG] Retrieval failed:", error);
                // Continue without memories on error
            }
        }

        // Map Zod messages to AI SDK CoreMessage and Inject Context
        const coreMessages: CoreMessage[] = messages.map((m) => {
            if (m.role === "tool") {
                return {
                    role: "tool",
                    content: [{ type: "tool-result", toolCallId: m.tool_call_id || "unknown", result: m.content || "" }],
                } as any as CoreMessage;
            }

            if (m.role === "assistant" && (m.tool_calls || m.content)) {
                const content: any[] = [];
                if (m.content) {
                    content.push({ type: "text", text: m.content });
                }
                if (m.tool_calls) {
                    m.tool_calls.forEach((tc: any) => {
                        content.push({
                            type: "tool-call",
                            toolCallId: tc.id,
                            toolName: tc.function.name,
                            args: typeof tc.function.arguments === "string"
                                ? JSON.parse(tc.function.arguments)
                                : tc.function.arguments
                        });
                    });
                }
                return {
                    role: "assistant",
                    content,
                } as any as CoreMessage;
            }

            return {
                role: m.role as "system" | "user" | "assistant",
                content: m.content || "",
            };
        });

        if (injectedSystemContext) {
            const systemMsgIndex = coreMessages.findIndex(m => m.role === "system");
            if (systemMsgIndex >= 0) {
                // Append to existing system message
                const existingContent = coreMessages[systemMsgIndex].content as string;
                coreMessages[systemMsgIndex] = {
                    role: "system",
                    content: existingContent + injectedSystemContext
                };
            } else {
                // Prepend new system message
                coreMessages.unshift({
                    role: "system",
                    content: `You are a helpful AI assistant.${injectedSystemContext}`
                });
            }
        }

        // Trigger Memory Formation in Background
        if (userId && lastUserMessage) {
            // Fire-and-forget
            memoryService.processMemories(userId, lastUserMessage, coreMessages).catch(err => {
                logger.error("Background memory processing failed:", err);
            });
        }

        const targetModel = mistral(model);

        try {
            if (isStream) {
                // Streaming response (SSE)
                const result = streamText({
                    model: targetModel,
                    messages: coreMessages,
                    temperature,
                    topP: top_p,
                    maxTokens: max_tokens || undefined,
                });

                // Set headers for SSE
                c.header("Content-Type", "text/event-stream");
                c.header("Cache-Control", "no-cache");
                c.header("Connection", "keep-alive");

                return stream(c, async (stream) => {
                    // OpenAI SSE Format:
                    // data: { ... JSON ... }
                    // data: [DONE]

                    const id = `chatcmpl-${Date.now()}`;
                    const created = Math.floor(Date.now() / 1000);

                    for await (const part of result.fullStream) {
                        if (part.type === "text-delta") {
                            const chunk = {
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: { content: part.textDelta },
                                        finish_reason: null,
                                    },
                                ],
                            };
                            await stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        } else if (part.type === "finish") {
                            const chunk = {
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {},
                                        finish_reason: part.finishReason,
                                    },
                                ],
                            };
                            await stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                        // Handle tool calls / usage etc if needed
                    }

                    await stream.write("data: [DONE]\n\n");
                });
            }

            const { generateText } = await import("ai");
            const result = await generateText({
                model: targetModel,
                messages: coreMessages,
                temperature,
                topP: top_p,
                maxTokens: max_tokens || undefined,
            });

            return c.json({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: result.text,
                        },
                        finish_reason: result.finishReason,
                    },
                ],
                usage: result.usage,
                memories: relevantMemories,
            });
        } catch (error) {
            logger.error("Chat completion error:", error);
            return c.json({ error: (error as Error).message }, 500);
        }
    },
);

const port = process.env.PORT || 3000;

logger.info(`API Service running on port ${port}`);

export { app };

export default {
    port,
    fetch: app.fetch,
};
