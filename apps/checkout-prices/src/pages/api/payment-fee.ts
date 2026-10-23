import type { NextApiRequest, NextApiResponse } from "next";

import {
  AddLinesToCheckoutDocument,
  CheckoutDetailsFragment,
  CheckoutLinesDeleteDocument,
  GetCheckoutDetailsDocument,
} from "../../../generated/graphql";
import { createAppGraphQLClient } from "../../lib/app-graphql-client";
import { handleCors } from "../../lib/cors";
import { checkoutLogRef, isCheckoutId } from "../../lib/saleor-ids";
import {
  centsToDecimalString,
  feeDisplayName,
  feeMetadataValue,
  isPaymentFeeLine,
  isValidCallerRatePercent,
  judgePaymentFee,
  PAYMENT_FEE_METADATA_KEY,
  readPaymentFeeConfig,
  toCents,
} from "../../modules/payment-fee/payment-fee";
import {
  type PaymentFeeCheckout,
  PaymentFeeCheckoutDocument,
} from "../../modules/payment-fee/payment-fee-checkout-query";

// Adds (apply=true) or removes (apply=false) the PayPal service-fee line on a
// checkout. The line uses a dedicated service variant (env
// PAYMENT_FEE_VARIANT_ID) with a custom price the app COMPUTES:
// rate (env PAYMENT_FEE_RATE_PERCENT, default 1.5) × the checkout's
// fee-exclusive total as Saleor reports it — see modules/payment-fee.
// Caller-supplied `amount`/`ratePercent`/`currency` are accepted for
// compatibility with existing storefront builds but never charged.
//
// A stale fee line is REPLACED, never changed in place: add the new line
// (checkoutLinesAdd, forceNewLine), then delete exactly the fee lines of this
// call's snapshot, then keep the oldest remaining fee line. The Stripe app
// checks the fee line's OWN price (undiscountedTotalPrice), and Saleor 3.22.74
// keeps a stored copy of it that an in-place price change can leave stale:
// checkoutLinesUpdate saves only quantity, price_override and metadata
// (checkout/utils.py:381-383), and the refresh of the copy can be skipped for
// up to CHECKOUT_PRICES_TTL (checkout/calculations.py:513-517; types.py:1183-1193
// bumps discount_expiration without saving the lines), while the INSERT writes
// it from the custom price (checkout/utils.py:447-466).
//
// A2c's goal is kept: the checkout is never without its fee line (payments
// review 2026-10-21). Between the add and the delete it holds two fee lines,
// which the Stripe app refuses (several-fee-lines: fails closed), never none.
// Deleting only snapshot lines means two concurrent calls never delete each
// other's new lines; keep-oldest makes them converge on one.
//
// Callers: the storefront browser (StripeCheckoutForm, PaymentRedirectHandler
// — cross-origin, allowlisted via ALLOWED_ORIGINS) and the storefront server
// (cart page fee cleanup — no Origin header). Ownership proof is the checkout
// ID itself (see lib/saleor-ids.ts): exactly what Saleor's public API accepts
// for the same checkout mutations.

/**
 * Extra swaps after the first one when the written fee is no longer the fee
 * the rule asks for: the fee line's own size moves the voucher spread, so the
 * base can move (a FIXED voucher, or a rounding remainder). The Stripe app
 * stays the judge of whatever state is returned.
 */
const MAX_CORRECTION_SWAPS = 2;

type SuccessfulResponse = {
  checkout: CheckoutDetailsFragment;
};

type ErrorResponse = {
  errorMessage: string;
};

export type PaymentFeeResponse = SuccessfulResponse | ErrorResponse;

type SaleorMutationError = { code: string; message?: string | null };

type SwapResult = { ok: true; checkout: CheckoutDetailsFragment } | { ok: false; status: 400 | 409; error: string };

function describeErrors(errors: ReadonlyArray<SaleorMutationError> | null | undefined, fallback: string): string {
  return errors && errors.length > 0
    ? errors.map((e) => `${e.code}: ${e.message ?? "no message"}`).join("; ")
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<PaymentFeeResponse>) {
  if (handleCors(req, res, { methods: ["POST", "OPTIONS"] })) {
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ errorMessage: "Method not allowed" });
  }

  const body = isRecord(req.body) ? req.body : {};
  const { checkoutId, apply, amount, ratePercent } = body;

  if (checkoutId === undefined || checkoutId === null || checkoutId === "") {
    return res.status(400).json({ errorMessage: "checkoutId has not been provided" });
  }
  if (!isCheckoutId(checkoutId)) {
    return res.status(400).json({ errorMessage: "checkoutId is not a valid checkout ID" });
  }
  if (apply === undefined) {
    return res.status(400).json({ errorMessage: "apply flag has not been provided" });
  }
  if (typeof apply !== "boolean") {
    return res.status(400).json({ errorMessage: "apply must be a boolean" });
  }
  if (ratePercent !== undefined && !isValidCallerRatePercent(ratePercent)) {
    return res.status(400).json({ errorMessage: "ratePercent must be a number in (0, 100]" });
  }

  // null when removing: that path needs no fee configuration.
  const feeConfig = apply ? readPaymentFeeConfig() : null;

  if (feeConfig && !feeConfig.ok) {
    console.error(`[payment-fee] Refusing to charge a fee: ${feeConfig.error}`);

    return res.status(500).json({ errorMessage: feeConfig.error });
  }

  const logRef = checkoutLogRef(checkoutId);
  const client = createAppGraphQLClient("payment-fee");

  const fetchDetails = async (): Promise<CheckoutDetailsFragment | null> => {
    const details = await client
      .query(GetCheckoutDetailsDocument, { id: checkoutId }, { requestPolicy: "network-only" })
      .toPromise();

    return details.data?.checkout ?? null;
  };

  // One consistent snapshot of the total and the fee lines it includes.
  const readSnapshot = async (): Promise<
    { ok: true; checkout: PaymentFeeCheckout | null } | { ok: false; error: string }
  > => {
    const snapshot = await client
      .query(PaymentFeeCheckoutDocument, { id: checkoutId }, { requestPolicy: "network-only" })
      .toPromise();

    return snapshot.error ? { ok: false, error: snapshot.error.message } : { ok: true, checkout: snapshot.data?.checkout ?? null };
  };

  const deleteLines = async (
    lineIds: string[],
  ): Promise<{ ok: true; checkout: CheckoutDetailsFragment } | { ok: false; error: string }> => {
    const del = await client.mutation(CheckoutLinesDeleteDocument, { checkoutId, lineIds }).toPromise();

    if (del.error) {
      return { ok: false, error: del.error.message };
    }
    const updated = del.data?.checkoutLinesDelete?.checkout;

    return updated
      ? { ok: true, checkout: updated }
      : { ok: false, error: describeErrors(del.data?.checkoutLinesDelete?.errors, "Deleting fee line failed") };
  };

  const first = await readSnapshot();

  if (!first.ok) {
    return res.status(400).json({
      errorMessage: `Could not get checkout details. Error: ${first.error}`,
    });
  }

  const checkout = first.checkout;

  if (!checkout) {
    return res.status(404).json({ errorMessage: "Checkout not found" });
  }

  const existingFeeLines = checkout.lines.filter(isPaymentFeeLine);

  if (feeConfig === null) {
    // apply=false: remove every fee line
    if (existingFeeLines.length === 0) {
      const current = await fetchDetails();

      return current
        ? res.status(200).json({ checkout: current })
        : res.status(404).json({ errorMessage: "Checkout not found" });
    }

    const removed = await deleteLines(existingFeeLines.map((line) => line.id));

    if (!removed.ok) {
      return res.status(400).json({ errorMessage: `Could not delete fee line. Error: ${removed.error}` });
    }

    return res.status(200).json({ checkout: removed.checkout });
  }

  // apply=true
  const { ratePercent: ratePercentServer, variantId: feeVariantId } = feeConfig;
  const rule = { ratePercent: ratePercentServer, variantId: feeVariantId };
  const currency = checkout.totalPrice.gross.currency;
  let judged = judgePaymentFee(checkout, rule);

  if (judged.baseCents <= 0) {
    return res.status(400).json({
      errorMessage: "Cannot apply a payment fee: the checkout has no payable total",
    });
  }

  if (ratePercent !== undefined && ratePercent !== ratePercentServer) {
    console.warn("[payment-fee] Caller ratePercent differs from PAYMENT_FEE_RATE_PERCENT; charging the server rate", {
      callerRatePercent: ratePercent,
      serverRatePercent: ratePercentServer,
    });
  }
  if (amount !== undefined && amount !== null) {
    const callerAmount = typeof amount === "number" || typeof amount === "string" ? Number(amount) : NaN;

    if (!Number.isFinite(callerAmount) || toCents(callerAmount) !== judged.feeCents) {
      console.warn("[payment-fee] Ignoring caller-supplied amount; charging the server-computed fee", {
        checkout: logRef,
        callerAmount: Number.isFinite(callerAmount) ? callerAmount : "invalid",
        serverAmount: centsToDecimalString(judged.feeCents),
        currency,
      });
    }
  }

  // Idempotent re-call: the single fee line's own price already is this fee.
  if (judged.settled) {
    const current = await fetchDetails();

    if (current) {
      return res.status(200).json({ checkout: current });
    }
  }

  /**
   * Replaces the fee lines of one snapshot with ONE new fee line of `feeCents`:
   * add, then delete exactly `snapshotFeeLineIds`, then keep the oldest
   * remaining fee line. A failed add changes nothing.
   */
  const swapFeeLine = async (feeCents: number, snapshotFeeLineIds: string[]): Promise<SwapResult> => {
    const add = await client
      .mutation(AddLinesToCheckoutDocument, {
        id: checkoutId,
        lines: [
          {
            quantity: 1,
            variantId: feeVariantId,
            price: centsToDecimalString(feeCents),
            forceNewLine: true,
            metadata: [
              { key: PAYMENT_FEE_METADATA_KEY, value: feeMetadataValue(ratePercentServer) },
              { key: "display_name", value: feeDisplayName(ratePercentServer) },
              { key: "currency", value: currency },
            ],
          },
        ],
      })
      .toPromise();

    if (add.error) {
      return { ok: false, status: 400, error: `Could not add fee line. Error: ${add.error.message}` };
    }

    const added = add.data?.checkoutLinesAdd?.checkout;

    if (!added) {
      return {
        ok: false,
        status: 400,
        error: describeErrors(add.data?.checkoutLinesAdd?.errors, "Adding fee line failed"),
      };
    }

    let current: CheckoutDetailsFragment = added;

    if (snapshotFeeLineIds.length > 0) {
      const removed = await deleteLines(snapshotFeeLineIds);

      if (removed.ok) {
        current = removed.checkout;
      } else {
        // A concurrent call may have removed them already: only then is this swap complete.
        const after = await fetchDetails();
        const replaced = new Set(snapshotFeeLineIds);

        if (!after || after.lines.some((line) => replaced.has(line.id))) {
          console.error("[payment-fee] The new fee line was added but the replaced one could not be removed", {
            checkout: logRef,
            error: removed.error,
          });

          return {
            ok: false,
            status: 409,
            error: `Could not remove the replaced fee line; the checkout holds two fee lines and is refused until the fee is applied again. Error: ${removed.error}`,
          };
        }
        current = after;
      }
    }

    // A concurrent call may have added its own fee line meanwhile. Keep the oldest
    // (Saleor orders lines by created_at, id) and drop the rest, so the checkout
    // always converges to exactly one fee line.
    const duplicateFeeLines = current.lines.filter(isPaymentFeeLine).slice(1);

    if (duplicateFeeLines.length > 0) {
      console.warn("[payment-fee] Concurrent fee lines detected; removing duplicates", {
        checkout: logRef,
        duplicates: duplicateFeeLines.length,
      });
      const deduped = await deleteLines(duplicateFeeLines.map((line) => line.id));

      if (deduped.ok) {
        return { ok: true, checkout: deduped.checkout };
      }

      // The other request may have removed them already — accept the state if it converged.
      const after = await fetchDetails();

      if (after && after.lines.filter(isPaymentFeeLine).length === 1) {
        return { ok: true, checkout: after };
      }

      return { ok: false, status: 409, error: "Payment fee lines changed concurrently; please retry" };
    }

    return { ok: true, checkout: current };
  };

  let latest: CheckoutDetailsFragment | null = null;

  for (let swap = 0; swap <= MAX_CORRECTION_SWAPS; swap += 1) {
    const swapped = await swapFeeLine(
      judged.feeCents,
      judged.feeLines.map((line) => line.id),
    );

    if (!swapped.ok) {
      return res.status(swapped.status).json({ errorMessage: swapped.error });
    }
    latest = swapped.checkout;

    // Judge the result with the rule the Stripe app applies.
    const reread = await readSnapshot();

    if (!reread.ok || !reread.checkout) {
      break;
    }
    judged = judgePaymentFee(reread.checkout, rule);

    if (judged.settled || judged.baseCents <= 0) {
      break;
    }
    if (swap < MAX_CORRECTION_SWAPS) {
      console.warn("[payment-fee] The fee moved after the write (order-level discount spread); replacing it again", {
        checkout: logRef,
        expectedFeeCents: judged.feeCents,
      });
    } else {
      console.warn("[payment-fee] The fee still moves after the last correction; returning the latest state", {
        checkout: logRef,
        expectedFeeCents: judged.feeCents,
      });
    }
  }

  return latest
    ? res.status(200).json({ checkout: latest })
    : res.status(409).json({ errorMessage: "Payment fee could not be applied; please retry" });
}
