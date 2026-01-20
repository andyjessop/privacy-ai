# AI API Stack

A privacy-focused AI suite that self-hosts your data, vector search, and user interface, while securely integrating with trusted privacy-preserving AI providers like Mistral.

This monorepo contains the infrastructure to run your own AI platform using **Mistral AI** models and **PGVector** for embeddings, fronted by the powerful **Open Web UI**.

## 🌟 Capabilities

-   **OpenAI-Compatible API**: Drop-in replacement for OpenAI clients. Currently powered by Mistral AI.
-   **Vector Search & RAG**: Dedicated microservice (`apps/vector`) for managing embeddings and semantic search using `pgvector`.
-   **Modern UI**: Integrated **Open Web UI** for a ChatGPT-like experience, supporting chat history, models, and more.
-   **High Performance**: Built on **Bun** and **Hono** for ultra-fast API responses.
-   **Type Safety**: End-to-end usage of TypeScript and Zod for robust validation.

## 🏗️ Architecture

The project is structured as a Bun workspaces monorepo:

-   **`apps/api`**: Public-facing API gateway not unlike OpenAI's API. Handles chat completions and proxies to LLM providers.
-   **`apps/vector`**: Internal service for storing and querying vector embeddings.
-   **`packages/`**: Shared libraries (logger, types).
-   **Infrastructure**:
    -   **PostgreSQL + pgvector**: Database for relational data and vector embeddings.
    -   **Docker Compose**: Orchestrates the entire stack for dev and prod.

---

## 🛠️ Development

### **Prerequisites**
- [Bun](https://bun.sh)
- Docker Desktop
- `.env.local` for development (`MISTRAL_API_KEY`).
- `.env.test` for running integration tests (`MISTRAL_API_KEY` - distinct key optional). Bun automatically loads the `.env.test` file, if present, when running tests.

### **Quick Start**

1. **Install Dependencies**
   ```bash
   bun install
   ```

2. **Start the API Service**
   Runs the API on `http://localhost:3000`.
   ```bash
   bun dev
   ```

3. **Start Open Web UI (Client)**
   Runs the Web UI on `http://localhost:8080`, connected to your local API.
   ```bash
   docker compose -f docker-compose.dev.yml up -d open-web-ui
   ```

4. **Access the Application**
   Open http://localhost:8080 in your browser.
   - Create an admin account (first time).
   - Select a Mistral model.
   - Start chatting.

### **Testing**

- **Run ALL tests:**
  ```bash
  bun test
  ```
- **Run API Integration Tests:**
  ```bash
  bun --cwd apps/api test
  ```

---

## 🚀 Deployment

To deploy the entire stack (API, Vector, Open Web UI, Postgres) using Docker Compose:

1.  **Clone the Repository**
    Copy this entire repository to your server.

2.  **Configure Environment**
    Create a `.env` file in the root directory:
    ```env
    ```env
    MISTRAL_API_KEY=your_key_here
    # Sets the password for the new database container and configured services to use it.
    # You can choose any password you like.
    POSTGRES_PASSWORD=your_secure_password
    ```

3.  **Run with Docker Compose**
    ```bash
    docker compose up -d --build
    ```

    This will:
    - Build `api` and `vector` services from source.
    - Start `postgres` database.
    - Start `open-web-ui` on port **8080**.

4.  **Access**
    The Web UI will be available at `http://<your-server-ip>:8080`.
