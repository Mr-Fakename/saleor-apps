# Stripe App Refund Debug Guide

## Overview
This document outlines the debugging implementation added to identify the refund webhook failure issue.

## Problem Description
- Refund requests initiated from Saleor Dashboard fail
- Error message: `"Incorrect value ({'error': {'type': 'SIGNATURE_VERIFICATION_FAILED', 'message': 'Request signature check failed'}}) for field: . Error: Value error, Providing 'pspReference' is required.."`
- Transaction has valid pspReference: `pi_3S94LMBgYEh91bJA1RIkhkBB`

## Debug Logging Added

### 1. Webhook Route Handler (`route.ts`)
**Logger**: `TRANSACTION_REFUND_REQUESTED route`

**Debug Points**:
- Request received with full headers and payload analysis
- Saleor API URL processing and validation
- Use case execution tracking
- Success/failure response details
- Unhandled error catching with stack traces

### 2. Use Case (`use-case.ts`)
**Logger**: `TransactionRefundRequestedUseCase`

**Debug Points**:
- Execution start with event validation
- Transaction extraction with error handling
- Channel ID extraction with detailed structure logging
- pspReference validation
- Stripe config retrieval and validation
- Stripe API call preparation and execution
- Response processing and Saleor money conversion
- Final success response creation

### 3. Recipient Verification (`with-recipient-verification.ts`)
**Logger**: `withRecipientVerification`

**Debug Points**:
- Recipient ID matching validation
- Authentication data comparison
- Verification pass/fail status

### 4. Webhook Signature Verification (`webhook-definition.ts`)
**Logger**: `transactionRefundRequestedWebhookDefinition`

**Debug Points**:
- JWKS, signature, and raw body validation
- Signature verification process
- Verification errors with stack traces

### 5. Transaction Helpers (`transaction-requested-event-helpers.ts`)
**Logger**: `transaction-requested-event-helpers`

**Debug Points**:
- Transaction extraction from event payload
- Channel ID extraction with structure analysis
- Missing data error handling

### 6. Response Handling (`use-case-response.ts`)
**Logger**: `TransactionRefundRequestedUseCaseResponse`

**Debug Points**:
- Success response creation with all IDs
- Failure response creation with error details
- Stripe environment validation

## How to Use This Debug Information

### 1. Enable Debug Logging
Ensure your environment has debug logging enabled. Check these environment variables:
```bash
LOG_LEVEL=debug
NODE_ENV=development
```

### 2. Monitor Specific Loggers
When testing refunds, filter logs for these specific debug markers:
```bash
# Search for any refund-related debug logs
grep "=== .* DEBUG:" app.log

# Search for specific components
grep "REFUND WEBHOOK DEBUG" app.log
grep "REFUND USE CASE DEBUG" app.log
grep "RECIPIENT VERIFICATION DEBUG" app.log
grep "WEBHOOK SIGNATURE DEBUG" app.log
```

### 3. Debug Flow Analysis

**Expected Flow**:
1. `=== REFUND WEBHOOK DEBUG: Request received ===`
2. `=== RECIPIENT VERIFICATION DEBUG: Checking recipient ===`
3. `=== WEBHOOK SIGNATURE DEBUG: Starting verification ===`
4. `=== REFUND USE CASE DEBUG: Starting execution ===`
5. `=== TRANSACTION HELPER DEBUG: Extracting transaction ===`
6. `=== CHANNEL HELPER DEBUG: Extracting channel ID ===`
7. `=== REFUND USE CASE DEBUG: Fetching Stripe config ===`
8. `=== REFUND USE CASE DEBUG: Calling Stripe refunds API ===`
9. `=== SUCCESS RESPONSE DEBUG: Creating success response ===`

**Where to Look for Issues**:

**Signature Verification Failure**:
- Look for `WEBHOOK SIGNATURE DEBUG: Verification error`
- Check JWKS, signature length, and raw body data
- Verify app registration and webhook secrets

**Recipient Verification Failure**:
- Look for `RECIPIENT VERIFICATION DEBUG: Recipient ID mismatch`
- Check app ID vs recipient ID matching

**Transaction Missing**:
- Look for `TRANSACTION HELPER DEBUG: Transaction not found in event`
- Check webhook payload structure

**pspReference Missing**:
- Look for `REFUND USE CASE DEBUG: Transaction missing pspReference`
- Verify transaction has proper Payment Intent ID

**Config Issues**:
- Look for `REFUND USE CASE DEBUG: Failed to get configuration`
- Check channel configuration and app setup

**Stripe API Issues**:
- Look for `REFUND USE CASE DEBUG: Failed to create refund`
- Check Stripe API keys and Payment Intent status

## Test Plan

### 1. Verify Debug Logging Works
```bash
# Start the app with debug logging
pnpm dev:debug

# Check logs are being generated
tail -f logs/app.log | grep "DEBUG"
```

### 2. Test Refund Flow
1. Navigate to Saleor Dashboard
2. Find a completed payment transaction
3. Initiate a refund request
4. Monitor debug logs in real-time
5. Identify at which debug point the flow fails

### 3. Analyze Signature Verification
If signature verification is failing:
1. Check webhook registration in Saleor admin
2. Verify webhook URL matches: `/api/webhooks/saleor/transaction-refund-requested`
3. Confirm app installation and permissions
4. Check webhook secret configuration

### 4. Manual Webhook Testing
Use tools like curl or Postman to send test webhook requests:
```bash
curl -X POST http://localhost:3000/api/webhooks/saleor/transaction-refund-requested \
  -H "Content-Type: application/json" \
  -H "saleor-api-url: http://localhost:8000/graphql/" \
  -H "saleor-event: TRANSACTION_REFUND_REQUESTED" \
  -d @test-webhook-payload.json
```

## Known Issues to Check

1. **App Installation**: Verify the Stripe app is properly installed in Saleor
2. **Webhook Registration**: Confirm webhooks are registered with correct URLs
3. **Permissions**: Check app has necessary permissions for transaction operations
4. **Configuration**: Verify Stripe config exists for the channel
5. **Network**: Ensure Saleor can reach the app webhook endpoints

## Cleanup
After debugging is complete, remove debug logging by reverting changes to:
- `route.ts`
- `use-case.ts`
- `with-recipient-verification.ts`
- `webhook-definition.ts`
- `transaction-requested-event-helpers.ts`
- `use-case-response.ts`

Or replace debug logs with more concise info/warn level logging for production monitoring.