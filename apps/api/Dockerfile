FROM oven/bun:1-alpine

WORKDIR /app

# Copy root dependency manifests
COPY package.json bun.lockb ./

# Copy packages and apps source code
COPY packages ./packages
COPY apps ./apps

# Install all dependencies (including workspace dependencies)
RUN bun install --frozen-lockfile

# Set working directory to the api app
WORKDIR /app/apps/api

# Expose port (default for Hono/Bun is often 3000, adjust as needed)
EXPOSE 3000

# Start the application
CMD ["bun", "run", "src/index.ts"]
