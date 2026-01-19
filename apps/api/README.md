# AI API Service

This service provides an OpenAI-compatible API layer for Mistral models, designed to be consumed by clients like OpenWebUI.

## Prerequisites

- [Bun](https://bun.sh) runtime installed.
- A Mistral API Key.

## Setup

1. **Install Dependencies**:
   ```bash
   bun install
   ```

2. **Configure Environment**:
   Create a `.env.local` type file in this directory (or ensure it exists in the project root if running from there, but `apps/api` specific is safer).
   
   ```bash
   touch .env.local
   ```
   
   Add your API key:
   ```env
   MISTRAL_API_KEY=your_actual_api_key_here
   ```

## Running in Development

To start the server with hot reloading:

```bash
bun start
```

The server will listen on port **3000** (default) or `PORT` environment variable.

## Smoke Tests

You can verify the API is working using `curl`.

### 1. List Models
Check if the API routes are up and returning models.

```bash
curl http://localhost:3000/v1/models
```

**Expected Output:** JSON response containing a list of `mistral-*` models.

### 2. Chat Completion (Streaming)
Test the streaming chat endpoint (SSE).

```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-small-latest",
    "messages": [
      {"role": "user", "content": "Say hello!"}
    ],
    "stream": true
  }'
```

**Expected Output:** A stream of `data: {...}` lines ending with `data: [DONE]`.

### 3. Chat Completion (Non-Streaming)
Test the standard JSON response.

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-small-latest",
    "messages": [
      {"role": "user", "content": "Say hello!"}
    ],
    "stream": false
  }'
```

**Expected Output:** A single JSON object containing the assistant's response in `choices[0].message.content`.
