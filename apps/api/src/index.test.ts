import { afterEach, beforeAll, describe, expect, spyOn, test, mock } from "bun:test";

// Mock AI SDK to avoid real API calls
mock.module("ai", () => {
	return {
		streamText: () => {
			// Mock async iterable for fullStream
			return {
				fullStream: (async function* () {
					yield { type: 'text-delta', textDelta: 'Mock ' };
					yield { type: 'text-delta', textDelta: 'Response' };
					yield { type: 'finish', finishReason: 'stop' };
				})()
			};
		},
		generateText: async () => ({
			text: "Mock response",
			finishReason: "stop",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
		}),
	};
});

import { app } from "./index";
import { vectorService } from "./services/vector-service";
import { memoryService } from "./services/memory-service";
import * as embeddingUtils from "./utils/embedding";

// Set dummy key
process.env.MISTRAL_API_KEY = "test-key";

// Mock embedding
spyOn(embeddingUtils, "mistralEmbed").mockResolvedValue([0.1, 0.2, 0.3]);

describe("API Service Integration Tests", () => {
	afterEach(() => {
		// Clear mocks
		// jest/bun clearAllMocks() equivalent?
	});

	// ... existing tests ...

	test("GET /v1/models should return model list", async () => {
		const res = await app.request("/v1/models");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.object).toBe("list");
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.length).toBeGreaterThan(0);
		expect(body.data[0].id).toBeDefined();
	});

	test("POST /v1/chat/completions (Non-Streaming) should return text", async () => {
		const payload = {
			model: "mistral-small-latest",
			messages: [
				{ role: "user", content: "What is 2+2? Answer with just the number." },
			],
			stream: false,
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.object).toBe("chat.completion");
		expect(body.choices).toHaveLength(1);
		expect(body.choices[0].message.content).toContain("Mock response");
	}, 20000);

	test("POST /v1/chat/completions (Streaming) should return SSE stream", async () => {
		const payload = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: "Count to 3." }],
			stream: true,
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");

		// Read stream
		if (!res.body) throw new Error("No response body");
		const reader = res.body.getReader();
		expect(reader).toBeDefined();

		const decoder = new TextDecoder();
		let done = false;
		let output = "";

		if (!reader) throw new Error("No reader");

		while (!done) {
			const { value, done: isDone } = await reader.read();
			if (isDone) {
				done = true;
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			output += chunk;
		}

		// Verify SSE format
		expect(output).toContain("data: {");
		expect(output).toContain("chat.completion.chunk");
		expect(output).toContain("[DONE]");
	}, 20000);

	test("POST /v1/chat/completions should trigger RAG and Memory Formation", async () => {
		// Spies
		const querySpy = spyOn(vectorService, "query").mockResolvedValue({
			matches: [
				{ id: "1", score: 0.9, metadata: { content: "User name is Andy" }, values: [] }
			]
		});

		const memorySpy = spyOn(memoryService, "processMemories").mockResolvedValue(undefined);

		const payload = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: "What is my name?" }],
			stream: false,
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: {
				"Content-Type": "application/json",
				"x-openwebui-user-id": "test-user-123"
			},
		});

		expect(res.status).toBe(200);
		const body = await res.json();

		// 1. Check Retrieval called
		expect(querySpy).toHaveBeenCalled();
		expect(querySpy.mock.calls[0][1]!.userId).toBe("test-user-123");

		// 2. Check Memory Formation triggered
		// Note: It's async fire-and-forget. Bun test might finish before it's called if we don't wait?
		// But the code calls it synchronously before returning (unawaited). 
		// So spy should record it.
		expect(memorySpy).toHaveBeenCalled();
		expect(memorySpy.mock.calls[0][0]).toBe("test-user-123");

		// 3. Response check (optional, seeing if it used the memory)
		// Since we mocked query to return "User name is Andy", LLM should probably say "Andy".
		const answer = body.choices[0].message.content;
		// console.log("Answer:", answer);
		// We can't strictly guarantee LLM uses it without strict prompt, but mistral-small is usually good.
		// We at least verified the plumbing.
	});
});
