# Customer Extensions App

A production-ready Saleor app that adds **Wishlists** and **Verified Reviews** functionality to your e-commerce storefront.

## Features

### Wishlists
- Create multiple wishlists per user
- Add/remove products to/from wishlists
- Manage wishlist items with denormalized product data
- Efficient querying with DynamoDB single-table design

### Verified Reviews
- Submit product reviews (rating + comment)
- Automatic purchase verification through Saleor GraphQL API
- "Verified Purchase" badge for authenticated reviews
- Duplicate review prevention (one review per user per product per order)
- Average rating calculation
- Full CRUD operations (create, read, update, delete)

## Architecture

### Tech Stack
- **Next.js 15** (App Router)
- **tRPC 11** - Type-safe API layer
- **DynamoDB** - Data storage
- **TypeScript** - Strict type safety
- **Zod** - Schema validation with branded types
- **neverthrow** - Result-based error handling
- **@saleor/app-sdk** - Saleor integration

### Design Patterns
- **Domain-Driven Design** - Separate domain logic from infrastructure
- **Repository Pattern** - Abstract data access
- **Branded Types** - Type-safe primitives (WishlistId, UserId, ProductId, etc.)
- **Result Types** - Explicit error handling without exceptions
- **Middleware Composition** - Layered authentication and service injection

## Project Structure

```
apps/customer-extensions/
├── src/
│   ├── app/
│   │   └── api/
│   │       ├── manifest/route.ts       # App manifest
│   │       ├── register/route.ts       # App registration
│   │       └── trpc/[trpc]/route.ts    # tRPC API endpoint
│   ├── modules/
│   │   ├── wishlists/
│   │   │   ├── domain/                 # Domain entities and types
│   │   │   ├── repositories/           # Data access layer
│   │   │   │   └── dynamodb/           # DynamoDB implementation
│   │   │   └── trpc-handlers/          # tRPC procedures
│   │   ├── reviews/
│   │   │   ├── domain/                 # Domain entities and types
│   │   │   ├── repositories/           # Data access layer
│   │   │   │   └── dynamodb/           # DynamoDB implementation
│   │   │   ├── services/               # Purchase verification
│   │   │   └── trpc-handlers/          # tRPC procedures
│   │   ├── saleor/                     # Saleor GraphQL client
│   │   ├── dynamodb/                   # DynamoDB client and table
│   │   └── trpc/                       # tRPC setup and context
│   ├── lib/                            # Shared utilities
│   └── __tests__/                      # Unit and integration tests
├── graphql/                            # GraphQL queries
├── generated/                          # Generated GraphQL types
└── scripts/                            # Setup and deployment scripts
```

## Installation

### Prerequisites
- Node.js 18+
- PNPM 8+
- AWS account with DynamoDB access
- Running Saleor instance

### Environment Variables

Create `.env.local`:

```bash
# Core
SECRET_KEY=<32-char-hex-for-aes-256>
ALLOWED_DOMAIN_PATTERN=.*

# APL (Auth Persistence Layer)
APL=dynamodb

# DynamoDB
DYNAMODB_MAIN_TABLE_NAME=saleor-customer-extensions
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<your-key>
AWS_SECRET_ACCESS_KEY=<your-secret>
INIT_DYNAMODB_ON_STARTUP=true

# Saleor API
SALEOR_API_URL=http://localhost:8000/graphql/
```

### Setup

```bash
# Install dependencies
pnpm install

# Initialize DynamoDB table
pnpm run setup-dynamodb

# Generate GraphQL types
pnpm run generate

# Start development server
pnpm dev
```

The app will be available at `http://localhost:3010`.

## API Reference

### Wishlists API

#### Create Wishlist
```typescript
trpc.wishlists.createWishlist.mutate({
  name: string,
  userId: string,
})
```

#### Get User Wishlists
```typescript
trpc.wishlists.getUserWishlists.useQuery({
  userId: string,
})
```

#### Get Wishlist Items
```typescript
trpc.wishlists.getWishlistItems.useQuery({
  wishlistId: string,
  userId: string,
})
```

#### Add to Wishlist
```typescript
trpc.wishlists.addToWishlist.mutate({
  wishlistId: string,
  userId: string,
  productId: string,
  variantId: string,
  productName: string,
})
```

#### Remove from Wishlist
```typescript
trpc.wishlists.removeFromWishlist.mutate({
  wishlistId: string,
  userId: string,
  productId: string,
  variantId: string,
})
```

#### Delete Wishlist
```typescript
trpc.wishlists.deleteWishlist.mutate({
  wishlistId: string,
  userId: string,
})
```

### Reviews API

#### Submit Review
```typescript
trpc.reviews.submitReview.mutate({
  productId: string,
  variantId?: string,
  userId: string,
  rating: number,      // 1-5
  comment: string,     // 10-1000 chars
})
```

#### Get Product Reviews
```typescript
trpc.reviews.getProductReviews.useQuery({
  productId: string,
})
// Returns: { reviews, averageRating, totalReviews }
```

#### Get User Reviews
```typescript
trpc.reviews.getUserReviews.useQuery({
  userId: string,
})
```

#### Can User Review
```typescript
trpc.reviews.canUserReview.useQuery({
  productId: string,
  variantId?: string,
  userId: string,
})
// Returns: { canReview, reason?, orderId? }
```

#### Update Review
```typescript
trpc.reviews.updateReview.mutate({
  reviewId: string,
  productId: string,
  userId: string,
  orderId: string,
  rating?: number,
  comment?: string,
})
```

#### Delete Review
```typescript
trpc.reviews.deleteReview.mutate({
  productId: string,
  userId: string,
  orderId: string,
})
```

## DynamoDB Schema

### Table: `saleor-customer-extensions`

**Partition Key (PK):** String
**Sort Key (SK):** String

### Access Patterns

#### Wishlists
- **Get user wishlists:** `PK=USER#{userId}`, `SK=WISHLIST#{wishlistId}`
- **Get wishlist items:** `PK=WISHLIST#{wishlistId}`, `SK=PRODUCT#{productId}#{variantId}`

#### Reviews
- **Get product reviews:** `PK=PRODUCT#{productId}`, `SK=REVIEW#{userId}#{orderId}`
- **Prevent duplicates:** Composite key ensures one review per user per product per order

## Domain Entities

### Wishlist
```typescript
class Wishlist {
  readonly id: WishlistId;
  readonly userId: UserId;
  readonly name: string;          // 1-100 chars
  readonly createdAt: Date;
  readonly modifiedAt: Date;
}
```

### WishlistItem
```typescript
class WishlistItem {
  readonly wishlistId: WishlistId;
  readonly productId: ProductId;
  readonly variantId: VariantId;
  readonly productName: string;    // Denormalized, 1-255 chars
  readonly addedAt: Date;
}
```

### ProductReview
```typescript
class ProductReview {
  readonly reviewId: ReviewId;
  readonly productId: ProductId;
  readonly userId: UserId;
  readonly orderId: OrderId;
  readonly userEmail: string;       // Denormalized
  readonly userName: string;        // Denormalized
  readonly rating: Rating;          // 1-5
  readonly comment: string;         // 10-1000 chars
  readonly verifiedPurchase: boolean;
  readonly createdAt: Date;
  readonly modifiedAt: Date;
}
```

## Testing

### Unit Tests
```bash
# Run unit tests
pnpm test

# Run with coverage
pnpm test:ci
```

**Test Coverage:**
- ✅ 39 unit tests passing
- ✅ Domain entity validation
- ✅ Edge cases and boundaries
- ✅ Error scenarios

### Integration Tests
```bash
# Run integration tests
pnpm test:integration
```

### Type Checking
```bash
pnpm check-types
```

## Storefront Integration

### Installation
```bash
cd saleor-storefront
pnpm add @trpc/client @trpc/react-query @trpc/next @tanstack/react-query
```

### Setup tRPC Client

**1. Create tRPC client:**
```typescript
// src/lib/trpc-client.ts
import { createTRPCReact } from "@trpc/react-query";
import type { TrpcRouter } from "../../../saleor-apps/apps/customer-extensions/src/modules/trpc/trpc-router";

export const trpc = createTRPCReact<TrpcRouter>();
```

**2. Create provider:**
```typescript
// src/lib/trpc-provider.tsx
import { TrpcProvider } from "@/lib/trpc-provider";

// Wrap app in layout.tsx
<TrpcProvider>{children}</TrpcProvider>
```

**3. Use in components:**
```typescript
import { trpc } from "@/lib/trpc-client";

function MyComponent() {
  const { data } = trpc.wishlists.getUserWishlists.useQuery({ userId });
  return <div>{/* ... */}</div>;
}
```

### UI Components

Pre-built React components are available in `saleor-storefront/src/ui/components/`:

#### Wishlists
- `WishlistButton.tsx` - Add to wishlist button with dropdown
- `WishlistItem.tsx` - Single wishlist item display
- `WishlistPage.tsx` - Full wishlist management page

#### Reviews
- `ProductReviews.tsx` - Main reviews component
- `ReviewCard.tsx` - Single review display
- `ReviewForm.tsx` - Review submission form
- `StarRating.tsx` - Star rating input/display

### Usage Example

```typescript
import { ProductReviews } from "@/ui/components/reviews/ProductReviews";
import { WishlistButton } from "@/ui/components/wishlist/WishlistButton";

export function ProductPage({ productId, userId }) {
  return (
    <div>
      {/* Product details */}

      <WishlistButton
        productId={productId}
        variantId={variantId}
        productName={productName}
        userId={userId}
      />

      <ProductReviews
        productId={productId}
        variantId={variantId}
        userId={userId}
      />
    </div>
  );
}
```

## Development

### Commands
```bash
pnpm dev           # Start development server (port 3010)
pnpm build         # Build for production
pnpm start         # Start production server
pnpm lint          # Lint code
pnpm lint:fix      # Fix linting issues
pnpm generate      # Generate GraphQL types
pnpm test          # Run unit tests
pnpm check-types   # Type check
```

### Code Generation
After modifying GraphQL queries in `graphql/`:
```bash
pnpm run generate
```

This generates TypeScript types in `generated/graphql.ts`.

## Deployment

### Production Checklist
- [ ] Configure production environment variables
- [ ] Set up production DynamoDB table
- [ ] Configure APL (use `dynamodb` for production)
- [ ] Set up proper AWS IAM roles and permissions
- [ ] Configure Sentry for error tracking
- [ ] Set up OpenTelemetry for observability
- [ ] Deploy to hosting platform (Vercel, AWS, etc.)
- [ ] Configure CORS and security headers
- [ ] Set up monitoring and alerts

### Environment Variables (Production)
```bash
SECRET_KEY=<production-secret-32-chars>
APL=dynamodb
DYNAMODB_MAIN_TABLE_NAME=saleor-customer-extensions-prod
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<production-key>
AWS_SECRET_ACCESS_KEY=<production-secret>
INIT_DYNAMODB_ON_STARTUP=false  # Pre-create table
SALEOR_API_URL=https://your-saleor-instance.com/graphql/
ALLOWED_DOMAIN_PATTERN=^https://your-domain\\.com$
```

### DynamoDB Production Setup
```bash
# Create table (run once)
pnpm run setup-dynamodb:prod
```

Or use AWS CLI:
```bash
aws dynamodb create-table \
  --table-name saleor-customer-extensions-prod \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

## Architecture Decisions

### Why DynamoDB?
- **Scalability**: Handles millions of wishlists and reviews
- **Performance**: Low-latency reads/writes
- **Single-table design**: Efficient access patterns
- **Serverless**: No infrastructure management

### Why tRPC?
- **Type safety**: End-to-end type inference
- **Developer experience**: Auto-completion and compile-time errors
- **Performance**: Automatic request batching
- **Simple**: No code generation needed

### Why Result Types?
- **Explicit errors**: No hidden exceptions
- **Composability**: Chain operations safely
- **Debugging**: Clear error paths
- **Type safety**: Error types are known at compile time

## Limitations & Future Enhancements

### Current Limitations
- `getUserReviews` requires scanning (would benefit from GSI)
- `getReviewById` has limited utility without userId+orderId
- No review moderation/flagging
- No review helpful votes
- No image uploads for reviews

### Potential Enhancements
- Add GSI for user-based review queries
- Implement review moderation queue
- Add review helpfulness voting
- Support review images/photos
- Add email notifications
- Implement review responses from vendors
- Add wishlist sharing functionality
- Support public/private wishlists

## Support

For issues, questions, or contributions:
- Check existing issues in the repository
- Create a new issue with detailed information
- Follow the project's contribution guidelines

## License

BSD-3-Clause (matches Saleor Apps monorepo)
