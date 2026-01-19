import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import {
	DeleteResponse,
	type InsertResponse,
	type QueryResponse,
} from "../../../packages/vector-types/src";
import { initDb, sql } from "./db";
import { app } from "./index";

// Force small dimension for tests
process.env.VECTOR_DIMENSION = "3";

describe("Vector Service Integration Tests", () => {
	beforeAll(async () => {
		// Wait for DB connection and init
		await initDb();
	});

	afterAll(async () => {
		// Close DB connection
		await sql.end();
	});

	describe("Basic CRUD Operations", () => {
		beforeEach(async () => {
			// Clean up table before tests
			await sql`DELETE FROM vectors`;
		});

		test("should insert vectors", async () => {
			const payload = {
				vectors: [
					{ id: "1", values: [0.1, 0.2, 0.3], metadata: { type: "test" } },
					{ id: "2", values: [0.9, 0.8, 0.7], metadata: { type: "test" } },
				],
			};

			const res = await app.request("/insert", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ count: 2, ids: ["1", "2"] });
		});

		test("should handle duplicate insert (ignore)", async () => {
			const payload = {
				vectors: [
					{ id: "1", values: [0.1, 0.2, 0.3], metadata: { type: "retry" } }, // Duplicate ID
					{ id: "3", values: [0.1, 0.1, 0.9], metadata: { type: "new" } },
				],
			};

			// Pre-seed ID 1
			await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({
					vectors: [{ id: "1", values: [0.1, 0.2, 0.3] }],
				}),
				headers: { "Content-Type": "application/json" },
			});

			const res = await app.request("/insert", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
			});

			expect(res.status).toBe(200);
			// Should only return the NEW id
			const body = (await res.json()) as InsertResponse;
			expect(body.count).toBe(1);
			expect(body.ids).toEqual(["3"]);
		});

		test("should upsert vectors (update existing)", async () => {
			// Pre-seed ID 1
			await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({
					vectors: [{ id: "1", values: [0.0, 0.0, 0.0] }],
				}), // Old value
				headers: { "Content-Type": "application/json" },
			});

			const payload = {
				vectors: [
					{ id: "1", values: [0.0, 0.1, 0.0], metadata: { type: "updated" } }, // Update
					{ id: "4", values: [1.0, 1.0, 1.0], metadata: { type: "upserted" } }, // Insert
				],
			};

			const res = await app.request("/upsert", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ count: 2, ids: ["1", "4"] });

			// Verify update
			const check = await app.request("/getByIds", {
				method: "POST",
				body: JSON.stringify({ ids: ["1"] }),
				headers: { "Content-Type": "application/json" },
			});
			const checkBody = await check.json();
			expect(checkBody[0].metadata.type).toBe("updated");
			expect(checkBody[0].values).toEqual([0, 0.1, 0]);
		});

		test("should query vectors by similarity", async () => {
			// Seed specific vectors for this test
			await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({
					vectors: [
						{ id: "1", values: [0, 0, 0] },
						{ id: "2", values: [0.9, 0.8, 0.7] },
						{ id: "3", values: [0.1, 0.1, 0.9] },
						{ id: "4", values: [1, 1, 1] },
					],
				}),
				headers: { "Content-Type": "application/json" },
			});

			// Let's query near [1,1,1] -> should match 4 first, then 2 or 3. 1 is furthest.

			const payload = {
				vector: [0.95, 0.95, 0.95],
				topK: 2,
				returnMetadata: true,
				returnValues: true,
			};

			const res = await app.request("/query", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as QueryResponse;

			expect(body.matches.length).toBe(2);

			// Match 1: ID 4 (Values [1,1,1] is very close to [0.95,0.95,0.95])
			expect(body.matches[0].id).toBe("4");
			expect(body.matches[0].score).toBeGreaterThan(0.99); // High similarity

			// Match 2: ID 2 ([0.9,0.8,0.7])
			expect(body.matches[1].id).toBe("2");
		});

		test("should delete vectors", async () => {
			// Seed
			await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({
					vectors: [
						{ id: "1", values: [1, 1, 1] },
						{ id: "3", values: [3, 3, 3] },
					],
				}),
				headers: { "Content-Type": "application/json" },
			});

			const payload = { ids: ["1", "3"] };
			const res = await app.request("/deleteByIds", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ count: 2, ids: ["1", "3"] });

			// Check finding deleted
			const check = await app.request("/getByIds", {
				method: "POST",
				body: JSON.stringify({ ids: ["1"] }),
				headers: { "Content-Type": "application/json" },
			});
			const checkBody = (await check.json()) as any[];
			expect(checkBody.length).toBe(0);
		});

		test("should handle invalid inputs", async () => {
			// Missing vector in insert
			const res1 = await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({ foo: "bar" }),
				headers: { "Content-Type": "application/json" },
			});
			expect(res1.status).toBe(400);

			// Invalid vector shape in query
			const res2 = await app.request("/query", {
				method: "POST",
				body: JSON.stringify({ vector: "invalid" }),
				headers: { "Content-Type": "application/json" },
			});
			expect(res2.status).toBe(400);
		});

		test("should handle validation errors (400)", async () => {
			// Trigger validation error by passing null ID
			const payload = {
				vectors: [{ id: null, values: [0, 0, 0] }],
			};
			const res = await app.request("/insert", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			// Zod error structure defaults to success: false, error: ... or similar?
			// Hono zValidator defaults: result.error if hook not provided?
			// It actually calls `c.json({ success: false, error: ... }, 400)` or similar?
			// Let's check received body in next run/debug.
			expect(body).toBeDefined();
		});
	});

	describe("Advanced Similarity Scenarios", () => {
		beforeEach(async () => {
			await sql`DELETE FROM vectors`;
			// Insert a diverse set of vectors relative to a reference [1, 0, 0]
			const testVectors = [
				{
					id: "exact",
					values: [1, 0, 0],
					metadata: { desc: "Same direction" },
				},
				{
					id: "near_scaled",
					values: [2, 0, 0],
					metadata: { desc: "Same direction, different magnitude" },
				}, // Should have same similarity as exact (score 1)
				{
					id: "close",
					values: [0.99, 0.14, 0],
					metadata: { desc: "10 degrees off" },
				}, // cos(10deg) ~= 0.98
				{
					id: "orthogonal",
					values: [0, 1, 0],
					metadata: { desc: "90 degrees off" },
				},
				{
					id: "opposite",
					values: [-1, 0, 0],
					metadata: { desc: "180 degrees off" },
				},
				{
					id: "random",
					values: [0.5, 0.5, 0.5],
					metadata: { desc: "Random 45deg-ish" },
				},
			];

			await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({ vectors: testVectors }),
				headers: { "Content-Type": "application/json" },
			});
		});

		test("should rank vectors correctly by cosine similarity", async () => {
			// Query with [1, 0, 0]
			const res = await app.request("/query", {
				method: "POST",
				body: JSON.stringify({
					vector: [1, 0, 0],
					topK: 10,
					returnMetadata: true,
				}),
				headers: { "Content-Type": "application/json" },
			});

			const body = (await res.json()) as QueryResponse;
			const matches = body.matches;

			// 1. Exact match (Score ~1.0)
			const exact = matches.find((m) => m.id === "exact");
			expect(exact).toBeDefined();
			expect(Math.abs(exact!.score - 1.0)).toBeLessThan(0.0001);

			// 2. Near scaled (Score ~1.0) - Cosine similarity ignores magnitude
			const nearScaled = matches.find((m) => m.id === "near_scaled");
			expect(nearScaled).toBeDefined();
			expect(Math.abs(nearScaled!.score - 1.0)).toBeLessThan(0.0001);

			// 3. Close (Score near 0.99)
			// Vector [0.99, 0.14, 0]. Norm ~= sqrt(0.99^2 + 0.14^2) ~= 1.0.
			// Dot product = 0.99. Cosine ~= 0.99.
			const close = matches.find((m) => m.id === "close");
			expect(close).toBeDefined();
			expect(close!.score).toBeGreaterThan(0.98);
			expect(close!.score).toBeLessThan(1.0);

			// 4. Orthogonal (Score ~0.0)
			const orthogonal = matches.find((m) => m.id === "orthogonal");
			expect(orthogonal).toBeDefined();
			expect(Math.abs(orthogonal!.score)).toBeLessThan(0.0001);

			// 5. Opposite (Score ~ -1.0)
			const opposite = matches.find((m) => m.id === "opposite");
			expect(opposite).toBeDefined();
			// pgvector cosine distance can go up to 2. Our score = 1 - distance.
			// distance = 2 -> score = -1.
			expect(Math.abs(opposite!.score - -1.0)).toBeLessThan(0.0001);

			// Verify Order: Exact/Scaled -> Close -> Random -> Orthogonal -> Opposite
			const ids = matches.map((m) => m.id);
			expect(ids.indexOf("exact")).toBeLessThan(ids.indexOf("close"));
			expect(ids.indexOf("near_scaled")).toBeLessThan(ids.indexOf("close")); // Tie with exact
			expect(ids.indexOf("close")).toBeLessThan(ids.indexOf("orthogonal"));
			expect(ids.indexOf("orthogonal")).toBeLessThan(ids.indexOf("opposite"));
		});

		test("should find nearest neighbor in dense cluster", async () => {
			// Add a cluster of points near [0, 1, 0]
			const cluster = [
				{ id: "c1", values: [0.01, 1.0, 0], metadata: { group: "y-axis" } }, // Very close
				{ id: "c2", values: [0.1, 1.0, 0], metadata: { group: "y-axis" } }, // Close
				{ id: "c3", values: [0.5, 1.0, 0], metadata: { group: "y-axis" } }, // Further
			];
			await app.request("/insert", {
				method: "POST",
				body: JSON.stringify({ vectors: cluster }),
				headers: { "Content-Type": "application/json" },
			});

			// Query for [0, 1, 0]
			const res = await app.request("/query", {
				method: "POST",
				body: JSON.stringify({
					vector: [0, 1, 0],
					topK: 3,
				}),
				headers: { "Content-Type": "application/json" },
			});
			const body = (await res.json()) as QueryResponse;
			const matches = body.matches;

			// Should find c1, c2, c3 in that order (ignoring previous 'orthogonal' which is exact match)
			// 'orthogonal' is [0,1,0], so it should be #1.
			// c1 is [0.01, 1, 0].
			// let's check top 3 excluding the exact 'orthogonal' one if it's there
			// The result should contain 'orthogonal' at top, then c1, then c2.

			const ids = matches.map((m) => m.id);
			// Ensure c1 is returned and better score than c2
			expect(ids).toContain("c1");
			expect(ids).toContain("c2");

			const c1Score = matches.find((m) => m.id === "c1")!.score;
			const c2Score = matches.find((m) => m.id === "c2")!.score;
			expect(c1Score).toBeGreaterThan(c2Score);
		});
	});
});
