FROM oven/bun:1-alpine

WORKDIR /app

# Copy root dependency manifests
COPY package.json bun.lockb ./

# Copy packages and apps source code
COPY packages ./packages
COPY apps ./apps

# Install all dependencies
RUN bun install --frozen-lockfile

# Set working directory to the vector app
WORKDIR /app/apps/vector

# Expose port if needed (assuming 3001 or similar if it's an API, or no port if just a worker)
# Placeholder for now
EXPOSE 3001

# Start the application
CMD ["bun", "run", "src/index.ts"]
