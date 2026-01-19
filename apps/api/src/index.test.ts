import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "./index";

describe("API Service Integration Tests", () => {

	// Check if API key is configured, otherwise warn/skip?
	// User authorized real calls, so we expect it to be present.
	const apiKey = process.env.MISTRAL_API_KEY;

	if (!apiKey) {
		console.warn("Skipping integration tests because MISTRAL_API_KEY is missing.");
		return;
	}

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
			messages: [{ role: "user", content: "What is 2+2? Answer with just the number." }],
			stream: false
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" }
		});

		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.object).toBe("chat.completion");
		expect(body.choices).toHaveLength(1);
		expect(body.choices[0].message.content).toContain("4");
	}, 10000); // Increased timeout for API call

	test("POST /v1/chat/completions (Streaming) should return SSE stream", async () => {
		const payload = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: "Count to 3." }],
			stream: true
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" }
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");

		// Read stream
		const reader = res.body?.getReader();
		expect(reader).toBeDefined();

		const decoder = new TextDecoder();
		let done = false;
		let output = "";

		while (!done) {
			const { value, done: isDone } = await reader!.read();
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
	}, 10000);
});
