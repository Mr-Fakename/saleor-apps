#!/bin/bash

# DynamoDB Table Setup Script using AWS CLI
# This script creates the required DynamoDB table for the digital-downloads app

set -e

# Configuration from environment or defaults
TABLE_NAME="${DYNAMODB_MAIN_TABLE_NAME:-digital-downloads-main-table}"
ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:8001}"
AWS_REGION="${AWS_REGION:-localhost}"

echo "Starting DynamoDB setup..."
echo "Table name: $TABLE_NAME"
echo "Endpoint: $ENDPOINT_URL"
echo "Region: $AWS_REGION"

# Check if table exists
if aws dynamodb describe-table \
    --table-name "$TABLE_NAME" \
    --endpoint-url "$ENDPOINT_URL" \
    --region "$AWS_REGION" \
    2>/dev/null; then
    echo "✓ Table $TABLE_NAME already exists - creation is skipped"
    exit 0
fi

echo "Table $TABLE_NAME does not exist, proceeding with creation..."

# Create the table
aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions \
        AttributeName=PK,AttributeType=S \
        AttributeName=SK,AttributeType=S \
    --key-schema \
        AttributeName=PK,KeyType=HASH \
        AttributeName=SK,KeyType=RANGE \
    --provisioned-throughput \
        ReadCapacityUnits=5,WriteCapacityUnits=5 \
    --endpoint-url "$ENDPOINT_URL" \
    --region "$AWS_REGION"

echo "✓ Table $TABLE_NAME created successfully"
echo "✓ DynamoDB setup completed successfully"
