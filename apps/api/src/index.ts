import { Hono } from "hono";
import { logger } from "@ai-api/logger/src/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamText } from "ai";
import { mistral } from "@ai-sdk/mistral";

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
const ChatCompletionSchema = z.object({
    model: z.string(),
    messages: z.array(
        z.object({
            role: z.enum(["system", "user", "assistant", "tool"]),
            content: z.string(),
        })
    ),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional().or(z.null()),
});

import { type CoreMessage } from "ai";

import { streamText as honoStreamText } from "hono/streaming";

// POST /v1/chat/completions
app.post("/v1/chat/completions", zValidator("json", ChatCompletionSchema), async (c) => {
    const body = c.req.valid("json");
    const { model, messages, stream, temperature, top_p, max_tokens } = body;

    logger.info(`Chat request for model: ${model}, stream: ${stream}`);

    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
        logger.error("MISTRAL_API_KEY not found in environment");
        return c.json({ error: "Server misconfiguration: API key missing" }, 500);
    }

    // Map Zod messages to AI SDK CoreMessage
    const coreMessages: CoreMessage[] = messages.map((m) => {
        // Simple mapping. "tool" role might need special handling if we supported tools fully, 
        // but for now user/assistant/system is main focus.
        // AI SDK CoreMessage expects 'role' + 'content'.
        if (m.role === 'tool') {
             // For now, map tool to specific structure or ignore if not supported in this simple pass
             // OpenAI 'tool' role messages usually have `tool_call_id`.
             // Our Zod schema is simplified.
             // Let's assume text-only for now or cast strict role.
             return {
                 role: 'tool',
                 content: [{ type: 'text', text: m.content }] as any, // Tool content usually array in AI SDK?
                 toolCallId: 'unknown' // Placeholder if we received tool message without ID in simplified schema
             } as unknown as CoreMessage; 
        }
        return {
            role: m.role as "system" | "user" | "assistant",
            content: m.content
        };
    });

    // Map model names if necessary or use directly if valid provider model
    // Using strict model passed by client
    // @ai-sdk/mistral reads process.env.MISTRAL_API_KEY automatically.
    const targetModel = mistral(model);

    try {
        if (stream) {
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

            return honoStreamText(c, async (stream) => {
                // OpenAI SSE Format:
                // data: { ... JSON ... }
                // data: [DONE]
                
                const id = `chatcmpl-${Date.now()}`;
                const created = Math.floor(Date.now() / 1000);

                 for await (const part of result.fullStream) {
                    if (part.type === 'text-delta') {
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
                    } else if (part.type === 'finish') {
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

        } else {
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
                     }
                 ],
                 usage: result.usage 
             });
        }

    } catch (error) {
        logger.error("Chat completion error:", error);
        return c.json({ error: (error as Error).message }, 500);
    }
});

const port = process.env.PORT || 3000;

logger.info(`API Service running on port ${port}`);

export default {
    port,
    fetch: app.fetch,
}
