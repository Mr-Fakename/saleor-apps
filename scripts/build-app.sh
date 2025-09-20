#!/bin/bash

# Build script for individual Saleor apps
# Usage: ./scripts/build-app.sh [app-name] [tag] [target]
# Example: ./scripts/build-app.sh stripe saleor-app-stripe:latest runner

set -e

# Default values
APP_NAME=${1:-stripe}
IMAGE_TAG=${2:-saleor-app-${APP_NAME}:latest}
BUILD_TARGET=${3:-runner}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Validate inputs
if [ -z "$APP_NAME" ]; then
    print_error "App name is required"
    echo "Usage: ./scripts/build-app.sh [app-name] [tag] [target]"
    exit 1
fi

if [ ! -d "apps/$APP_NAME" ]; then
    print_error "App 'apps/$APP_NAME' does not exist"
    echo "Available apps:"
    ls -1 apps/
    exit 1
fi

# Start build process
print_status "Building Saleor app: $APP_NAME"
print_status "Image tag: $IMAGE_TAG"
print_status "Build target: $BUILD_TARGET"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    print_error "Docker is not running. Please start Docker and try again."
    exit 1
fi

# Build the Docker image
print_status "Starting Docker build..."
docker build \
    --build-arg APP_NAME="$APP_NAME" \
    --target "$BUILD_TARGET" \
    --tag "$IMAGE_TAG" \
    --progress=plain \
    .

if [ $? -eq 0 ]; then
    print_success "Successfully built $IMAGE_TAG"
    
    # Show image info
    print_status "Image information:"
    docker images "$IMAGE_TAG" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
    
    # Optional: Run quick validation
    print_status "Running quick validation..."
    if docker run --rm -d --name temp-validation "$IMAGE_TAG" >/dev/null 2>&1; then
        sleep 2
        if docker ps --filter "name=temp-validation" --format "{{.Names}}" | grep -q temp-validation; then
            print_success "Container started successfully"
            docker stop temp-validation >/dev/null 2>&1
        else
            print_warning "Container may have exited immediately - check logs if needed"
        fi
    fi
    
    print_success "Build completed successfully!"
    echo ""
    echo "Next steps:"
    echo "  - Run the app: docker run -p 3000:3000 $IMAGE_TAG"
    echo "  - Use with docker-compose: docker-compose up ${APP_NAME}"
    echo "  - Push to registry: docker push $IMAGE_TAG"
else
    print_error "Build failed"
    exit 1
fi