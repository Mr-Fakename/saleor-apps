#!/bin/sh
set -e

echo "[INIT] Starting DynamoDB initialization script..."

# Wait for the Next.js server to be ready
MAX_ATTEMPTS=30
ATTEMPT=0
PORT="${PORT:-3001}"

echo "[INIT] Waiting for Next.js server on port $PORT..."

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if wget --spider --quiet "http://127.0.0.1:$PORT/api/manifest" 2>/dev/null || \
     wget --spider --quiet "http://localhost:$PORT/api/manifest" 2>/dev/null || \
     wget --spider --quiet "http://0.0.0.0:$PORT/api/manifest" 2>/dev/null; then
    echo "[INIT] ✓ Next.js server is ready"
    break
  fi

  ATTEMPT=$((ATTEMPT + 1))
  echo "[INIT] Attempt $ATTEMPT/$MAX_ATTEMPTS - Server not ready yet, waiting..."
  sleep 2
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  echo "[INIT] ✗ Server failed to start within timeout period"
  exit 1
fi

# Call the setup-db endpoint to create DynamoDB tables
echo "[INIT] Calling /api/setup-db to initialize DynamoDB tables..."

# Try 127.0.0.1 first, then localhost, then 0.0.0.0
RESPONSE=$(wget --post-data="" --header="Content-Type: application/json" \
  --output-document=- \
  --quiet \
  "http://127.0.0.1:$PORT/api/setup-db" 2>&1) || \
RESPONSE=$(wget --post-data="" --header="Content-Type: application/json" \
  --output-document=- \
  --quiet \
  "http://localhost:$PORT/api/setup-db" 2>&1) || \
RESPONSE=$(wget --post-data="" --header="Content-Type: application/json" \
  --output-document=- \
  --quiet \
  "http://0.0.0.0:$PORT/api/setup-db" 2>&1) || \
RESPONSE="ERROR"

if echo "$RESPONSE" | grep -q "success.*true"; then
  echo "[INIT] ✓ DynamoDB initialization successful"
  echo "[INIT] Response: $RESPONSE"
else
  echo "[INIT] ⚠️  DynamoDB initialization encountered an issue"
  echo "[INIT] Response: $RESPONSE"
  # Don't fail - the app might work with other APL types
fi

echo "[INIT] Initialization script completed"
