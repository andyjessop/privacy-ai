#!/bin/bash
set -e

echo "Starting Test Database..."
docker compose -f docker-compose.test.yml up -d --wait

echo "Running Vector Service Tests..."
# Set ENV for test DB
export DATABASE_URL="postgres://postgres:postgres@localhost:5433/ai_api_test"
export VECTOR_DIMENSION=3 # Use small dim for easy testing
# Run tests with coverage
bun test apps/vector/src/index.test.ts --coverage

EXIT_CODE=$?

echo "Stopping Test Database..."
docker compose -f docker-compose.test.yml down -v

exit $EXIT_CODE
