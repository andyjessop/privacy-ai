# Memories Implementation Spec

## 1. Goal
Enable the AI API to store and retrieve "memories" (semantic facts) for users, enhancing response relevance and personalization over time.
Memories are generated asynchronously in the background during chat interactions and retrieved via vector search during subsequent requests.

## 2. Architecture & Schema

### 2.1 Database Schema (Postgres + pgvector)

To support many-to-many relationships (e.g., shared memories) and clean separation, we will introduce a join table.

**Table: `vectors` (Existing)**
- `id` (TEXT, PK): Unique identifier for the memory vector.
- `values` (VECTOR[1536]): The embedding.
- `metadata` (JSONB): Stores the actual memory content (text), timestamp, and other metadata.
    - `{ "content": "User is a software engineer using Bun.", "type": "memory", "created_at": "..." }`

**Table: `users_vectors` (New)**
- `user_id` (TEXT): The user identifier (from OpenWebUI header `x-openwebui-user-id`).
- `vector_id` (TEXT): Foreign key to `vectors.id`.
- `PRIMARY KEY (user_id, vector_id)`

### 2.2 Models
- **Embeddings**: `mistral-embed` (via Mistral SDK).
- **Extraction/Ranking**: `mistral-small` (via AI SDK `generateObject`).

## 3. Data Flow (RAG Pipeline)

When `POST /v1/chat/completions` is called:

### Step 1: Retrieval (Synchronous)
1.  **Extract User ID**: Read `x-openwebui-user-id` header.
2.  **Embed Query**: Generate embedding for the latest user message using `mistral-embed`.
3.  **Search**: Query `vectors` table joined with `users_vectors`:
    ```sql
    SELECT v.*, match_score(v.values, $query_embedding) as score
    FROM vectors v
    JOIN users_vectors uv ON v.id = uv.vector_id
    WHERE uv.user_id = $user_id
    ORDER BY score DESC
    LIMIT 10
    ```

### Step 2: Reranking & Selection (Synchronous - Low Latency)
*Optimized Strategy*: Instead of heavy `generateObject` reranking for *retrieval* (which adds latency), we will use **Score Thresholding**.
- Filter results where `score > 0.8` (approximate semantic relevance).
- Selected memories are injected into the System Prompt context.
- The system prompt should suggest for the LLM to "re-rank on the fly" if it feels the retrieved memories are not relevant.

### Step 3: Response Generation (Synchronous)
- Call Mistral Chat Completion with:
    - System Prompt (including retrieved memories).
    - Chat History.
- Stream response to user immediately.

### Step 4: Memory Formation (Asynchronous / Fire-and-Forget)
*Triggered in background after response stream starts.*
1.  **Analyze**: Use `generateObject` with an LLM to analyze the User Message + Context.
    - Prompt: "Extract new, concise, permanent facts about the user from this message. Ignore transient info."
    - Schema: `{ memories: string[] }`
2.  **Deduplicate**:
    - Compare extracted memories against currently retrieved memories (from Step 1).
    - (Optionally) Semantic check against DB if high precision needed.
3.  **Store**:
    - For each new memory:
        - Generate Embedding (`mistral-embed`).
        - Insert into `vectors`.
        - Insert into `users_vectors` linking to current `$user_id`.

## 4. Implementation Details

### 4.1 `apps/vector` Updates
- **New Table**: Run DDL to create `users_vectors`.
- **Update Query Endpoint**: Add optional `userId` filter parameter.
    - If `userId` provided, perform JOIN.
    - If not, search all (or strict policy: require userId).

### 4.2 `apps/api` Updates
- **Middleware**: Extract `x-openwebui-user-id` header globally.
- **Background Worker**: Since we are in a serverless-like environment (Hono), we must ensure background tasks complete.
    - **Bun/Node**: Standard unawaited `Promise` is usually fine but can be lost on crash.
    - **Pattern**: `startBackgroundMemoryProcess(userId, message, context)` -> generic exception handler.

### 4.3 Validation & Edge Cases
- **Privacy**: Ensure `user_id` is strictly enforced. One user sees ONLY their memories.
- **Race Conditions**: Two parallel requests creating same memory -> Duplicate entries.
    - *Mitigation*: Vector store naturally allows duplicates, but exact string match check prevents literal dupes.
- **User ID Absence**: If no user ID header?
    - *Policy*: Disable memory feature for that request (Anonymous mode).

## 5. Future Considerations
- **Shared Memories**: `users_vectors` allows multiple users to look at the same `vector_id`.
- **Memory Decay**: Add `last_accessed` to `users_vectors` to slowly "forget" unused memories.