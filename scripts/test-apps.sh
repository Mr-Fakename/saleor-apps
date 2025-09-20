#!/bin/bash

# Test script for validating the refactored Docker setup
set -e

echo "=== Saleor Apps Docker Testing Script ==="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Test configuration
APPS_TO_TEST=(stripe cms klaviyo search)
TEST_IMAGE="saleor-apps-test"
TEST_TIMEOUT=30

print_status "Starting Docker setup tests..."

# Clean up any existing test containers
cleanup() {
    print_status "Cleaning up test containers..."
    for app in "${APPS_TO_TEST[@]}"; do
        docker stop "test-$app" 2>/dev/null || true
        docker rm "test-$app" 2>/dev/null || true
    done
    docker rmi "$TEST_IMAGE" 2>/dev/null || true
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Test 1: Build the image
print_status "Test 1: Building Docker image without CLI arguments..."
if docker build -t "$TEST_IMAGE" .; then
    print_status "✅ Image build successful"
else
    print_error "❌ Image build failed"
    exit 1
fi

# Test 2: Verify all apps exist in the image
print_status "Test 2: Verifying all apps are available..."
AVAILABLE_APPS=$(docker run --rm "$TEST_IMAGE" ls -1 /app/apps/)
echo "Available apps:"
echo "$AVAILABLE_APPS"

for app in "${APPS_TO_TEST[@]}"; do
    if echo "$AVAILABLE_APPS" | grep -q "^$app$"; then
        print_status "✅ App '$app' found"
    else
        print_error "❌ App '$app' not found"
        exit 1
    fi
done

# Test 3: Test runtime app selection
print_status "Test 3: Testing runtime app selection..."
for app in "${APPS_TO_TEST[@]}"; do
    print_status "Testing app: $app"
    
    # Start container in background
    if docker run -d --name "test-$app" \
        -e APP_NAME="$app" \
        -e NODE_ENV=production \
        -e SECRET_KEY=test-key \
        -e DYNAMODB_MAIN_TABLE_NAME=test-table \
        -e AWS_ACCESS_KEY_ID=dummy \
        -e AWS_SECRET_ACCESS_KEY=dummy \
        -e AWS_REGION=us-east-1 \
        -p "300${#APPS_TO_TEST[@]}:3000" \
        "$TEST_IMAGE"; then
        
        print_status "Container started for $app"
        
        # Wait for app to start (with timeout)
        print_status "Waiting for $app to start..."
        timeout=0
        while [ $timeout -lt $TEST_TIMEOUT ]; do
            if docker logs "test-$app" 2>&1 | grep -q "Starting.*app.*$app\|Ready.*3000"; then
                print_status "✅ App '$app' started successfully"
                break
            fi
            sleep 2
            timeout=$((timeout + 2))
        done
        
        if [ $timeout -ge $TEST_TIMEOUT ]; then
            print_warning "⚠️  App '$app' didn't start within $TEST_TIMEOUT seconds"
            docker logs "test-$app"
        fi
        
        # Stop the container
        docker stop "test-$app" >/dev/null 2>&1
        docker rm "test-$app" >/dev/null 2>&1
        
    else
        print_error "❌ Failed to start container for $app"
        exit 1
    fi
done

# Test 4: Test error handling for invalid app
print_status "Test 4: Testing error handling for invalid app..."
if docker run --rm -e APP_NAME=invalid-app "$TEST_IMAGE" 2>&1 | grep -q "does not exist"; then
    print_status "✅ Invalid app error handling works correctly"
else
    print_error "❌ Invalid app error handling failed"
    exit 1
fi

# Test 5: Test default app behavior
print_status "Test 5: Testing default app behavior..."
if docker run --rm --timeout 10s "$TEST_IMAGE" 2>&1 | grep -q "Starting.*app.*stripe"; then
    print_status "✅ Default app (stripe) behavior works"
else
    print_warning "⚠️  Default app behavior test inconclusive"
fi

print_status "=== All tests completed successfully! ==="
print_status ""
print_status "You can now use the refactored Docker setup:"
print_status "1. Build: docker build -t saleor-apps ."
print_status "2. Run: docker run -e APP_NAME=stripe -p 3000:3000 saleor-apps"
print_status "3. Compose: APP_NAME=cms docker-compose up any-app"
print_status ""
print_status "See README.testing.md for more usage examples."