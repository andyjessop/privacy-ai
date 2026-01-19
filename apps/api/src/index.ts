import { Hono } from "hono";
import { logger } from "../../../packages/logger/src/logger";
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
    metadata: z.record(z.any()).optional()
}).passthrough();

import { stream } from "hono/streaming";
import { type CoreMessage } from "ai";

// POST /v1/chat/completions
app.post("/v1/chat/completions", zValidator("json", ChatCompletionSchema), async (c) => {
    const body = c.req.valid("json");
    /* e.g.
    "x-openwebui-chat-id": "d66482b0-900e-46e6-94db-3a099d3d2395",
    "x-openwebui-user-email": "andrewdjessop@protonmail.com",
    "x-openwebui-user-id": "9b6d1053-a226-470f-a5fb-317b6eb7575d",
    "x-openwebui-user-name": "Andy Jessop",
    "x-openwebui-user-role": "admin",
    */
    const headers = c.req.header();
    const { model, messages, stream: isStream, temperature, top_p, max_tokens } = body;

    logger.info(`Chat request for model: ${model}, stream: ${isStream}`);

    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
        logger.error("MISTRAL_API_KEY not found in environment");
        return c.json({ error: "Server misconfiguration: API key missing" }, 500);
    }

    // Map Zod messages to AI SDK CoreMessage
    const coreMessages: CoreMessage[] = messages.map((m) => {
        if (m.role === 'tool') {
            return {
                role: 'tool',
                content: [{ type: 'text', text: m.content }] as any,
                toolCallId: 'unknown'
            } as unknown as CoreMessage;
        }
        return {
            role: m.role as "system" | "user" | "assistant",
            content: m.content
        };
    });

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

export { app };

export default {
    port,
    fetch: app.fetch,
}
