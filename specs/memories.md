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
    - `{ "content": "User is a software engineer using Bun.", "type": "memory", "created_at": "ISO-8601 Timestamp" }`

**Table: `users_vectors` (New)**
- `user_id` (TEXT): The user identifier (from OpenWebUI header `x-openwebui-user-id`).
- `vector_id` (TEXT): Foreign key to `vectors.id`.
- `PRIMARY KEY (user_id, vector_id)`

**Table: `memory_updates` (New)** To handle Conflict Resolution, we need to track which memories superseded others. This table is **Audit-only**.
- `id` (UUID, PK): Unique record identifier.
- `user_id` (TEXT NOT NULL): The user whose memory was updated. required to disambiguate shared vectors.
- `old_vector_id` (TEXT): The ID of the deprecated/contradicted memory.
- `new_vector_id` (TEXT): The ID of the updated memory.
- `reason` (TEXT): Why it was changed (e.g., "User switched from Bun to Node").
- `created_at` (TIMESTAMP): When the update occurred.

> **Note**: This table is **NOT** consulted during retrieval. Retrieval relies solely on the active links in `users_vectors`. This table exists purely for audit, debugging, and offline analysis of memory evolution.

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
    - Compare extracted memories against currently retrieved memories (from Step 1). LLM Prompt: "Does Fact A ('User uses Node') contradict Fact B ('User uses Bun')? If yes, mark Fact B for replacement."
    - Semantic check against DB.
3.  **Store**:
    - For each new memory:
        - Generate Embedding (`mistral-embed`).
        - Insert into `vectors`.
        - Insert into `users_vectors` linking to current `$user_id`.
        - If a contradiction is found, delete the old link in `users_vectors` for that user and record the change in `memory_updates`. This preserves the data in vectors (in case other users share it) but removes it from the specific user's context.

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
- **The "Flip-Flop"**: If a user says "I like coffee" then "I hate coffee" in the same hour.
    - Mitigation: Timestamp check. Only allow replacement if the new message is strictly newer than the stored `created_at`.

### 4.4 Memory Formation Prompt (Draft)

We will use `generateObject` with the following system prompt to analyze user messages.

**System Prompt:**
```text
You are an expert memory archivist. Your goal is to extract new, permanent facts, preferences, or meaningful details about the user that should be remembered for future conversations.

Input Context:
- Existing Memories: {existing_memories_list}
- User Message: {user_message}

Instructions:
1. Analyze the User Message for factual statements about the user's life, work, preferences, or state.
2. Ignore transient information (e.g., "Hello", "How are you?", "Write a poem", "I am testing this").
3. Ignore facts that are already present in "Existing Memories".
4. Extract facts as concise, standalone sentences (e.g., "User is a software engineer using Bun", "User prefers TypeScript").
5. Return a JSON object with a list of strings called 'memories'.
6. If no new information is found, return an empty list.
```

### 4.5 Cold Start Optimization

To avoid the "empty brain" feel for new users, we implement Static Global Memories. Global Bootstrap: A set of "Community/System" memories (e.g., general documentation facts about the backend) can be linked to all users by default if their personal memory count is <5.

### 4.6 Conflict Resolution Prompt

Compare the New Fact to the Existing Memory.
Existing: {existing_memory}
New: {new_fact}

Identify:
1. Is the New Fact a direct contradiction? (e.g., "I live in NY" vs "I moved to LA")
2. Is the New Fact a more specific version? (e.g., "I like JS" vs "I like TypeScript")
3. Is it unrelated?

Action: If (1) or (2), return { "action": "replace", "target_id": "{id}" }. Otherwise return { "action": "add" }.

#### Conflict Resolution Table

| Scenario | Logic | Result |
| :--- | :--- | :--- |
| **Direct Contradiction** | New fact replaces old fact. | Old `vector_id` unlinked; New inserted. |
| **Redundancy** | New fact is semantically identical. | Ignore new fact; No DB write. |
| **Refinement** | New fact adds detail to old fact. | Replace old with more descriptive version. |
| **New Information** | No relation to existing data. | Standard insert. |

### 4.7 Observability & Metrics

Given the opacity of LLM-driven extraction, extensive logging is critical.

**Structured Logs (JSON)**
- `memory_decision`: Logged for every background process execution.
  ```json
  {
    "event": "memory_decision",
    "user_id": "...",
    "input_message_length": 150,
    "extracted_count": 2,
    "decisions": [
      { "fact": "User likes Bun", "action": "add" },
      { "fact": "User moved to Node", "action": "replace", "target_id": "123" },
      { "fact": "User is a dev", "action": "ignore", "reason": "redundant" }
    ]
  }
  ```

**Metrics (Counters)**
- `memory_total_count`: Total active memories per user.
- `memory_replacement_rate`: Rate of conflict resolutions vs new additions.
- `memory_dedup_rate`: Frequency of redundant fact extraction (efficiency metric).
- `retrieval_hit_rate`: How often retrieved memories are actually used (requires feedback loop, future work).

## 5. Future Considerations
- **Shared Memories**: `users_vectors` allows multiple users to look at the same `vector_id`.
- **Memory Decay**: Since all memories have a `created_at` timestamp, we can implement a decay function in the retrieval score.
    - `final_score = vector_score * decay(current_time - created_at)`
    - This allows old memories to fade unless they are reinforced or extremely relevant.

## 6. Testing Strategy

To ensure reliability, we will implement the following tests with as close to 100% coverage as possible:

### 6.1 Vector Layer (`apps/vector`)
- **Unit Tests**:
    -   Verify database interactions (CRUD on `vectors`, `users_vectors`).
    -   Verify correct handling of `userId` in queries.
    -   Verify conflict resolution logic (if implemented in DB layer or mocked).

### 6.2 API Layer (`apps/api`)
- **Integration Tests**:
    -   Verify the full flow: Retrieval -> Chat -> Memory Formation.
    -   Create a file of pre-generated embeddings. To generate this file, make real calls to `mistral-embed` so that the vector dimensions are correct when running the test
    -   **Setup**:
        -   Insert pre-generated embeddings into the DB (simulating existing memories).
    -   **Assertions**:
        -   Call `POST /v1/chat/completions`. Makes calls to the real `mistral-embed` endpoint.
        -   Assert that the response contains a `memories` array (indicating retrieval usage).
        -   Assert that the "Memory Formation" background process logs (or DB side-effects) occur correctly (e.g., new memory added to DB).
        -   Ensure assertions are deterministic (check for existence/count, not exact vector scores).