import Stripe from "stripe";

/**
 * The API version pinned by the installed stripe-node (the type rejects any other value).
 * Sent with every API request and set on webhook endpoints created from now on. Endpoints
 * created before keep the version they were created with (2025-04-30.basil before stripe 19).
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2025-10-29.clover";
