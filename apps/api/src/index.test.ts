import { describe, expect, test } from "bun:test";
import { app } from "./index";
import { vectorService } from "./services/vector-service";
import { mistralEmbed } from "./utils/embedding";

// Ensure MISTRAL_API_KEY is present for real calls
if (!process.env.MISTRAL_API_KEY) {
	console.warn("Skipping integration tests because MISTRAL_API_KEY is missing.");
}

const TEST_USER_ID = `test-user-${Date.now()}`;

// Helper to poll for memory existence
async function pollForMemory(userId: string, contentSnippet: string, timeoutMs = 10000) {
	const start = Date.now();
	const queryVector = await mistralEmbed(contentSnippet); // Embedding for the snippet itself should match

	while (Date.now() - start < timeoutMs) {
		try {
			const results = await vectorService.query(queryVector, {
				userId,
				topK: 10,
				returnMetadata: true
			});

			const found = results.matches.some(m =>
				m.metadata?.content &&
				(m.metadata.content as string).toLowerCase().includes(contentSnippet.toLowerCase())
			);

			if (found) return true;
		} catch (e) {
			// Ignore errors during polling (e.g. connectivity blips)
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`Timed out waiting for memory containing "${contentSnippet}"`);
}

describe("API Service Integration Tests (Real)", () => {

	test("GET /v1/models should return model list", async () => {
		const res = await app.request("/v1/models");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.object).toBe("list");
		expect(Array.isArray(body.data)).toBe(true);
	});

	test("POST /v1/chat/completions should return 400 for invalid payload (missing messages)", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "mistral-small-latest" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	test("POST /v1/chat/completions should return 400 for invalid payload (missing model)", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	test("POST /v1/chat/completions should return 400 for invalid message structure", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "mistral-small-latest",
				messages: [{ role: "user" }] // missing content
			}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	test("POST /v1/chat/completions should return 400 for invalid role", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "mistral-small-latest",
				messages: [{ role: "superuser", content: "hi" }]
			}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	// Only run these if we have an API key
	const runRealTests = process.env.MISTRAL_API_KEY ? test : test.skip;

	runRealTests("POST /v1/chat/completions (Streaming)", async () => {
		const payload = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: "Count to 3." }],
			stream: true,
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: {
				"Content-Type": "application/json",
				"x-openwebui-user-id": TEST_USER_ID // Use ID but we primarily test streaming here
			},
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");

		// Basic stream consumption
		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		if (reader) {
			let done = false;
			while (!done) {
				const { done: d } = await reader.read();
				done = d;
			}
		}
	});

	runRealTests("Anonymous User (No Memory)", async () => {
		const uniqueContent = "I am anonymous " + Date.now();
		const payload = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: uniqueContent }],
			stream: false,
		};
		// No user ID header
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		// Should NOT have 'memories' populated
		expect(body.memories).toEqual([]);

		// Verify Vector API directly
		// Wait briefly to allow any potential background process to start (if it were buggy)
		await new Promise(r => setTimeout(r, 2000));

		const embedding = await mistralEmbed(uniqueContent);
		// Query globally (no userId) to see if it exists anywhere
		const results = await vectorService.query(embedding, { topK: 1, returnMetadata: true });

		const found = results.matches.some(m =>
			m.metadata?.content === uniqueContent
		);
		expect(found).toBe(false);
	}, 30000);



	runRealTests("Full Memory RAG Flow", async () => {
		// 1. First turn: State a fact
		const payload1 = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: "My name is Antimatter." }],
			stream: false,
		};

		const res1 = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload1),
			headers: {
				"Content-Type": "application/json",
				"x-openwebui-user-id": TEST_USER_ID
			},
		});

		expect(res1.status).toBe(200);
		const body1 = await res1.json();
		// First time, memories should likely be empty (unless previous runs persisted)
		// We can't guarantee empty if DB persists, but we used a unique user ID.
		// But let's check structure.
		expect(body1.memories).toBeDefined();

		// Wait for background memory formation deterministically
		await pollForMemory(TEST_USER_ID, "Antimatter");

		// 2. Verify memory via Vector Service (white-box testing)
		// Handled by pollForMemory implicitly checking it exists.

		// 3. Second turn: Ask about the fact
		const payload2 = {
			model: "mistral-small-latest",
			messages: [{ role: "user", content: "What is my name?" }],
			stream: false,
		};

		const res2 = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload2),
			headers: {
				"Content-Type": "application/json",
				"x-openwebui-user-id": TEST_USER_ID
			},
		});

		expect(res2.status).toBe(200);
		const body2 = await res2.json();

		// Check memories were retrieved
		expect(Array.isArray(body2.memories)).toBe(true);
		// Expect at least one memory about the name
		const hasMemory = body2.memories.some((m: string) => m.toLowerCase().includes("antimatter"));
		expect(hasMemory).toBe(true);

		// Check LLM answer
		const answer = body2.choices[0].message.content;
		expect(answer.toLowerCase()).toContain("antimatter");
	}, 60000); // Extended timeout
});
