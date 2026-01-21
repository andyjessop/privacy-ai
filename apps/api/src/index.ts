import { zValidator } from "@hono/zod-validator";
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

// Validates the OpenAI chat completion format
const ChatCompletionSchema = z
    .object({
        model: z.string(),
        messages: z.array(z.any()), // Allow lenient message structure (tool calls etc)
        stream: z.boolean().optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_tokens: z.number().optional().or(z.null()),
        tools: z.array(z.any()).optional(),
        tool_choice: z.any().optional(),
        metadata: z.record(z.any()).optional(),
    })
    .passthrough();

// POST /v1/chat/completions
app.post(
    "/v1/chat/completions",
    zValidator("json", ChatCompletionSchema),
    async (c) => {
        const body = c.req.valid("json");
        const _headers = c.req.header();

        const { model, stream: isStream, metadata } = body;

        logger.info(`Chat request for model: ${model}, stream: ${isStream}`);
        if (metadata) {
            logger.info(`User Valves/Metadata: ${JSON.stringify(metadata)}`);
        }

        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) {
            logger.error("MISTRAL_API_KEY not found in environment");
            return c.json({ error: "Server misconfiguration: API key missing" }, 500);
        }

        try {
            // Proxy request to Mistral API
            const response = await fetch(
                "https://api.mistral.ai/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey}`,
                    },
                    // Filter out metadata or extra fields that Mistral might reject?
                    // Validation schema used .passthrough(), so body includes everything.
                    // We should probably construct a clean payload.
                    body: JSON.stringify({
                        model: body.model,
                        messages: body.messages,
                        stream: body.stream,
                        temperature: body.temperature,
                        top_p: body.top_p,
                        max_tokens: body.max_tokens,
                        tools: body.tools,
                        tool_choice: body.tool_choice,
                    }),
                },
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`Mistral API error: ${response.status} ${errorText}`);
                return c.json(
                    { error: `Upstream error: ${errorText}` },
                    response.status as any,
                );
            }

            // Proxy the response stream directly
            return new Response(response.body, {
                status: response.status,
                headers: {
                    "Content-Type":
                        response.headers.get("Content-Type") || "application/json",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache",
                },
            });
        } catch (error) {
            logger.error("Proxy error:", error);
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
