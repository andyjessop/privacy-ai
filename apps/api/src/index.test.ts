import { describe, expect, test, mock, afterAll, beforeEach } from "bun:test";
import { app } from "./index";
import { logger } from "../../../packages/logger/src/logger";

describe("API Proxy Service", () => {
	const originalFetch = globalThis.fetch;
	const originalEnv = process.env;

	// Spy on logger
	const loggerSpy = mock((_msg: string) => { });
	const originalLoggerInfo = logger.info;
	const originalLoggerError = logger.error;

	beforeEach(() => {
		process.env = { ...originalEnv, MISTRAL_API_KEY: "test-key" };
		logger.info = loggerSpy;
		logger.error = loggerSpy;
		loggerSpy.mockClear();
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
		process.env = originalEnv;
		logger.info = originalLoggerInfo;
		logger.error = originalLoggerError;
	});

	// --- GET /v1/models ---
	test("GET /v1/models should return supported models", async () => {
		const res = await app.request("/v1/models");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.object).toBe("list");
		expect(body.data).toHaveLength(3);
		expect(body.data[0].id).toBe("mistral-small-latest");
	});

	// --- POST /v1/chat/completions: Auth ---
	test("POST /v1/chat/completions should fail if MISTRAL_API_KEY is missing", async () => {
		delete process.env.MISTRAL_API_KEY;
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "test", messages: [] }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toContain("Server misconfiguration");
	});

	// --- POST /v1/chat/completions: Validation ---
	test("POST /v1/chat/completions should return 400 for invalid JSON", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: "{ invalid json }",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400); // Hono validator handles this
	});

	test("POST /v1/chat/completions should return 400 for missing model", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ messages: [] }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	// --- POST /v1/chat/completions: Proxy Logic ---
	test("POST /v1/chat/completions should proxy request and return response", async () => {
		const mockResponse = new Response(
			JSON.stringify({ choices: [{ message: { content: "Proxy Success" } }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
		const fetchSpy = mock(() => Promise.resolve(mockResponse));
		globalThis.fetch = fetchSpy;

		const payload = {
			model: "mistral-small",
			messages: [{ role: "user", content: "Hi" }],
			temperature: 0.7,
		};

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.choices[0].message.content).toBe("Proxy Success");

		// Verify request payload
		const call = fetchSpy.mock.calls[0] as unknown as [
			string,
			{ body: string; headers: Record<string, string> },
		];
		expect(call).toBeDefined();
		const reqBody = JSON.parse(call[1].body);
		expect(reqBody.model).toBe(payload.model);
		expect(reqBody.temperature).toBe(0.7);
		expect(call[1].headers.Authorization).toBe("Bearer test-key");
	});

	test("POST /v1/chat/completions should pass Tools and Tool Choice", async () => {
		const mockResponse = new Response("{}", { status: 200 });
		const fetchSpy = mock(() => Promise.resolve(mockResponse));
		globalThis.fetch = fetchSpy;

		const payload = {
			model: "model",
			messages: [],
			tools: [{ type: "function", function: { name: "test" } }],
			tool_choice: "any",
		};

		await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
		});

		const call = fetchSpy.mock.calls[0] as unknown as [
			string,
			{ body: string },
		];
		const reqBody = JSON.parse(call[1].body);
		expect(reqBody.tools).toEqual(payload.tools);
		expect(reqBody.tool_choice).toBe("any");
	});

	// --- POST /v1/chat/completions: Metadata ---
	test("POST /v1/chat/completions should log metadata", async () => {
		const mockResponse = new Response("{}", { status: 200 }); // Mock response
		globalThis.fetch = () => Promise.resolve(mockResponse); // prevent network error

		await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "test",
				messages: [],
				metadata: { userId: "123" },
			}),
			headers: { "Content-Type": "application/json" },
		});

		expect(loggerSpy).toHaveBeenCalled();
		const logs = loggerSpy.mock.calls.map((c) => c[0]).join(" ");
		expect(logs).toContain("User Valves/Metadata");
		expect(logs).toContain("userId");
	});

	// --- POST /v1/chat/completions: Upstream Errors ---
	test("POST /v1/chat/completions should handle upstream 401 Unauthorized", async () => {
		const mockResponse = new Response("Invalid API Key", { status: 401 });
		globalThis.fetch = () => Promise.resolve(mockResponse);

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "test", messages: [] }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toContain("Upstream error");
		expect(body.error).toContain("Invalid API Key");
	});

	test("POST /v1/chat/completions should handle fetch network errors", async () => {
		globalThis.fetch = () => Promise.reject(new Error("Network Failure"));

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "test", messages: [] }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe("Network Failure");
	});

	// --- POST /v1/chat/completions: Streaming ---
	test("POST /v1/chat/completions should handle streaming response", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: chunk1\n\n"));
				controller.close();
			},
		});
		const mockResponse = new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		});
		globalThis.fetch = () => Promise.resolve(mockResponse);

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "test", messages: [], stream: true }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		const text = await res.text();
		expect(text).toContain("data: chunk1");
	});
});
