#!/bin/bash

# Initialize DynamoDB tables for Saleor Apps
# This script creates the necessary tables for storing Stripe events and app configurations

set -e

# Default values
DYNAMODB_ENDPOINT=${DYNAMODB_ENDPOINT:-"http://localhost:8000"}
AWS_REGION=${AWS_REGION:-"us-east-1"}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-"dummy"}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-"dummy"}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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

# Set AWS CLI configuration
export AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=$AWS_REGION

# Wait for DynamoDB to be ready
print_status "Waiting for DynamoDB to be ready..."
for i in {1..30}; do
    if curl -s $DYNAMODB_ENDPOINT > /dev/null 2>&1; then
        print_success "DynamoDB is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        print_error "DynamoDB is not responding after 30 attempts"
        exit 1
    fi
    sleep 1
done

# Function to create table if it doesn't exist
create_table_if_not_exists() {
    local table_name=$1
    local key_schema=$2
    local attribute_definitions=$3
    local billing_mode=${4:-"PAY_PER_REQUEST"}
    
    print_status "Checking if table '$table_name' exists..."
    
    if aws dynamodb describe-table --table-name "$table_name" --endpoint-url "$DYNAMODB_ENDPOINT" > /dev/null 2>&1; then
        print_warning "Table '$table_name' already exists, skipping creation"
        return 0
    fi
    
    print_status "Creating table '$table_name'..."
    
    aws dynamodb create-table \
        --table-name "$table_name" \
        --key-schema "$key_schema" \
        --attribute-definitions "$attribute_definitions" \
        --billing-mode "$billing_mode" \
        --endpoint-url "$DYNAMODB_ENDPOINT" > /dev/null
    
    if [ $? -eq 0 ]; then
        print_success "Successfully created table '$table_name'"
        
        # Wait for table to be active
        print_status "Waiting for table '$table_name' to be active..."
        aws dynamodb wait table-exists --table-name "$table_name" --endpoint-url "$DYNAMODB_ENDPOINT"
        print_success "Table '$table_name' is now active"
    else
        print_error "Failed to create table '$table_name'"
        return 1
    fi
}

print_status "Initializing DynamoDB tables for Saleor Apps..."

# 1. Stripe Events Table - Stores Stripe webhook events for idempotency and audit
create_table_if_not_exists \
    "StripeEvents" \
    "AttributeName=stripe_event_id,KeyType=HASH" \
    "AttributeName=stripe_event_id,AttributeType=S AttributeName=created_at,AttributeType=N" \
    "PAY_PER_REQUEST"

# Add GSI for querying by timestamp
print_status "Adding GSI to StripeEvents table..."
aws dynamodb update-table \
    --table-name "StripeEvents" \
    --attribute-definitions "AttributeName=stripe_event_id,AttributeType=S AttributeName=created_at,AttributeType=N AttributeName=event_type,AttributeType=S" \
    --global-secondary-index-updates \
        "Create={IndexName=EventTypeIndex,KeySchema=[{AttributeName=event_type,KeyType=HASH},{AttributeName=created_at,KeyType=RANGE}],Projection={ProjectionType=ALL},ProvisionedThroughput={ReadCapacityUnits=5,WriteCapacityUnits=5}}" \
    --endpoint-url "$DYNAMODB_ENDPOINT" > /dev/null 2>&1 || print_warning "GSI may already exist or table billing mode doesn't support it"

# 2. App Configuration Table - Stores app-specific configuration per Saleor installation
create_table_if_not_exists \
    "AppConfiguration" \
    "AttributeName=saleor_api_url,KeyType=HASH AttributeName=config_key,KeyType=RANGE" \
    "AttributeName=saleor_api_url,AttributeType=S AttributeName=config_key,AttributeType=S"

# 3. Stripe Customer Data Table - Maps Saleor customers to Stripe customers
create_table_if_not_exists \
    "StripeCustomers" \
    "AttributeName=saleor_user_id,KeyType=HASH" \
    "AttributeName=saleor_user_id,AttributeType=S AttributeName=stripe_customer_id,AttributeType=S"

# Add GSI for reverse lookup
print_status "Adding GSI to StripeCustomers table..."
aws dynamodb update-table \
    --table-name "StripeCustomers" \
    --attribute-definitions "AttributeName=saleor_user_id,AttributeType=S AttributeName=stripe_customer_id,AttributeType=S" \
    --global-secondary-index-updates \
        "Create={IndexName=StripeCustomerIndex,KeySchema=[{AttributeName=stripe_customer_id,KeyType=HASH}],Projection={ProjectionType=ALL},ProvisionedThroughput={ReadCapacityUnits=5,WriteCapacityUnits=5}}" \
    --endpoint-url "$DYNAMODB_ENDPOINT" > /dev/null 2>&1 || print_warning "GSI may already exist or table billing mode doesn't support it"

# 4. Payment Intent Tracking Table - Tracks payment intents and their status
create_table_if_not_exists \
    "StripePaymentIntents" \
    "AttributeName=payment_intent_id,KeyType=HASH" \
    "AttributeName=payment_intent_id,AttributeType=S AttributeName=saleor_payment_id,AttributeType=S AttributeName=created_at,AttributeType=N"

# Add GSI for querying by Saleor payment ID
print_status "Adding GSI to StripePaymentIntents table..."
aws dynamodb update-table \
    --table-name "StripePaymentIntents" \
    --attribute-definitions "AttributeName=payment_intent_id,AttributeType=S AttributeName=saleor_payment_id,AttributeType=S AttributeName=created_at,AttributeType=N" \
    --global-secondary-index-updates \
        "Create={IndexName=SaleorPaymentIndex,KeySchema=[{AttributeName=saleor_payment_id,KeyType=HASH},{AttributeName=created_at,KeyType=RANGE}],Projection={ProjectionType=ALL},ProvisionedThroughput={ReadCapacityUnits=5,WriteCapacityUnits=5}}" \
    --endpoint-url "$DYNAMODB_ENDPOINT" > /dev/null 2>&1 || print_warning "GSI may already exist or table billing mode doesn't support it"

# 5. App Installation Table - Tracks app installations per Saleor instance
create_table_if_not_exists \
    "AppInstallations" \
    "AttributeName=saleor_api_url,KeyType=HASH AttributeName=app_name,KeyType=RANGE" \
    "AttributeName=saleor_api_url,AttributeType=S AttributeName=app_name,AttributeType=S AttributeName=installed_at,AttributeType=N"

print_success "All DynamoDB tables have been initialized successfully!"

print_status "Table Summary:"
aws dynamodb list-tables --endpoint-url "$DYNAMODB_ENDPOINT" --output table

print_status "You can access DynamoDB Admin UI at: http://localhost:8001"
print_status "DynamoDB endpoint: $DYNAMODB_ENDPOINT"

print_success "DynamoDB initialization completed!"