import type { NextApiRequest, NextApiResponse } from "next";

import {
  AddLinesToCheckoutDocument,
  CheckoutDetailsFragment,
  CheckoutLinesDeleteDocument,
  CheckoutLinesUpdateDocument,
  GetCheckoutDetailsDocument,
} from "../../../generated/graphql";
import { createAppGraphQLClient } from "../../lib/app-graphql-client";
import { handleCors } from "../../lib/cors";
import { checkoutLogRef, isCheckoutId } from "../../lib/saleor-ids";
import {
  centsToDecimalString,
  computeFeeCents,
  feeDisplayName,
  feeMetadataValue,
  isPaymentFeeLine,
  isValidCallerRatePercent,
  PAYMENT_FEE_METADATA_KEY,
  readPaymentFeeConfig,
  toCents,
} from "../../modules/payment-fee/payment-fee";
import { PaymentFeeCheckoutDocument } from "../../modules/payment-fee/payment-fee-checkout-query";

// Adds (apply=true) or removes (apply=false) the PayPal service-fee line on a
// checkout. The line uses a dedicated service variant (env
// PAYMENT_FEE_VARIANT_ID) with a custom price the app COMPUTES:
// rate (env PAYMENT_FEE_RATE_PERCENT, default 1.5) × the checkout's
// fee-exclusive total as Saleor reports it — see modules/payment-fee.
// Caller-supplied `amount`/`ratePercent`/`currency` are accepted for
// compatibility with existing storefront builds but never charged.
//
// A single existing fee line is corrected IN PLACE (one checkoutLinesUpdate),
// never deleted and re-added: in between, a concurrent PaymentIntent resync
// could read the checkout without its fee (payments review 2026-10-21, A2c).
//
// Callers: the storefront browser (StripeCheckoutForm, PaymentRedirectHandler
// — cross-origin, allowlisted via ALLOWED_ORIGINS) and the storefront server
// (cart page fee cleanup — no Origin header). Ownership proof is the checkout
// ID itself (see lib/saleor-ids.ts): exactly what Saleor's public API accepts
// for the same checkout mutations.

type SuccessfulResponse = {
  checkout: CheckoutDetailsFragment;
};

type ErrorResponse = {
  errorMessage: string;
};

export type PaymentFeeResponse = SuccessfulResponse | ErrorResponse;

type SaleorMutationError = { code: string; message?: string | null };

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

  // One consistent snapshot of the total and the fee lines it includes.
  const snapshot = await client.query(PaymentFeeCheckoutDocument, { id: checkoutId }).toPromise();

  if (snapshot.error) {
    return res.status(400).json({
      errorMessage: `Could not get checkout details. Error: ${snapshot.error.message}`,
    });
  }

  const checkout = snapshot.data?.checkout;

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
  const currency = checkout.totalPrice.gross.currency;
  const existingFeeCents = existingFeeLines.reduce((sum, line) => sum + toCents(line.totalPrice.gross.amount), 0);
  const feeExclusiveTotalCents = toCents(checkout.totalPrice.gross.amount) - existingFeeCents;

  if (feeExclusiveTotalCents <= 0) {
    return res.status(400).json({
      errorMessage: "Cannot apply a payment fee: the checkout has no payable total",
    });
  }

  const feeCents = computeFeeCents(feeExclusiveTotalCents, ratePercentServer);
  const markerValue = feeMetadataValue(ratePercentServer);

  if (ratePercent !== undefined && ratePercent !== ratePercentServer) {
    console.warn("[payment-fee] Caller ratePercent differs from PAYMENT_FEE_RATE_PERCENT; charging the server rate", {
      callerRatePercent: ratePercent,
      serverRatePercent: ratePercentServer,
    });
  }
  if (amount !== undefined && amount !== null) {
    const callerAmount = typeof amount === "number" || typeof amount === "string" ? Number(amount) : NaN;

    if (!Number.isFinite(callerAmount) || toCents(callerAmount) !== feeCents) {
      console.warn("[payment-fee] Ignoring caller-supplied amount; charging the server-computed fee", {
        checkout: logRef,
        callerAmount: Number.isFinite(callerAmount) ? callerAmount : "invalid",
        serverAmount: centsToDecimalString(feeCents),
        currency,
      });
    }
  }

  const feeLineMetadata = [
    { key: PAYMENT_FEE_METADATA_KEY, value: markerValue },
    { key: "display_name", value: feeDisplayName(ratePercentServer) },
    { key: "currency", value: currency },
  ];
  const [onlyFeeLine] = existingFeeLines;
  const singleFeeLine = existingFeeLines.length === 1 && onlyFeeLine.variant.id === feeVariantId ? onlyFeeLine : null;

  // Idempotent re-call: the single fee line already carries this exact fee.
  if (
    singleFeeLine &&
    singleFeeLine.quantity === 1 &&
    toCents(singleFeeLine.totalPrice.gross.amount) === feeCents &&
    singleFeeLine.metadata.some((m) => m.key === PAYMENT_FEE_METADATA_KEY && m.value === markerValue)
  ) {
    const current = await fetchDetails();

    if (current) {
      return res.status(200).json({ checkout: current });
    }
  }

  let updatedCheckout: CheckoutDetailsFragment;

  if (singleFeeLine) {
    // One fee line with a stale price, rate marker or quantity: correct it in
    // ONE checkoutLinesUpdate (a custom price needs HANDLE_CHECKOUTS, as on
    // add), so the checkout is never without its fee line. If the line was
    // deleted meanwhile Saleor reports an error and re-creates nothing.
    const update = await client
      .mutation(CheckoutLinesUpdateDocument, {
        checkoutId,
        lines: [
          {
            lineId: singleFeeLine.id,
            quantity: 1,
            price: centsToDecimalString(feeCents),
            metadata: feeLineMetadata,
          },
        ],
      })
      .toPromise();

    if (update.error) {
      return res.status(400).json({ errorMessage: `Could not update fee line. Error: ${update.error.message}` });
    }

    const updated = update.data?.checkoutLinesUpdate?.checkout;

    if (!updated) {
      return res.status(400).json({
        errorMessage: `Could not update fee line. Error: ${describeErrors(
          update.data?.checkoutLinesUpdate?.errors,
          "Updating fee line failed",
        )}`,
      });
    }
    updatedCheckout = updated;
  } else {
    // No fee line, duplicates from an earlier race, or a line on another
    // variant: remove EVERY existing fee line, then add exactly one.
    if (existingFeeLines.length > 0) {
      const removed = await deleteLines(existingFeeLines.map((line) => line.id));

      if (!removed.ok) {
        return res.status(400).json({
          errorMessage: `Could not update fee line (delete failed). Error: ${removed.error}`,
        });
      }
    }

    const add = await client
      .mutation(AddLinesToCheckoutDocument, {
        id: checkoutId,
        lines: [
          {
            quantity: 1,
            variantId: feeVariantId,
            price: centsToDecimalString(feeCents),
            forceNewLine: true,
            metadata: feeLineMetadata,
          },
        ],
      })
      .toPromise();

    if (add.error) {
      return res.status(400).json({
        errorMessage: `Could not add fee line. Error: ${add.error.message}`,
      });
    }

    const added = add.data?.checkoutLinesAdd?.checkout;

    if (!added) {
      return res.status(400).json({
        errorMessage: describeErrors(add.data?.checkoutLinesAdd?.errors, "Adding fee line failed"),
      });
    }
    updatedCheckout = added;
  }

  // A concurrent call may have added its own fee line between our read and
  // our write. Keep the oldest (Saleor orders lines by created_at, id) and
  // drop the rest, so the checkout always converges to exactly one fee line.
  const duplicateFeeLines = updatedCheckout.lines.filter(isPaymentFeeLine).slice(1);

  if (duplicateFeeLines.length > 0) {
    console.warn("[payment-fee] Concurrent fee lines detected; removing duplicates", {
      checkout: logRef,
      duplicates: duplicateFeeLines.length,
    });
    const deduped = await deleteLines(duplicateFeeLines.map((line) => line.id));

    if (deduped.ok) {
      return res.status(200).json({ checkout: deduped.checkout });
    }

    // The other request may have removed them already — accept the state if it converged.
    const current = await fetchDetails();

    if (current && current.lines.filter(isPaymentFeeLine).length === 1) {
      return res.status(200).json({ checkout: current });
    }

    return res.status(409).json({ errorMessage: "Payment fee lines changed concurrently; please retry" });
  }

  return res.status(200).json({ checkout: updatedCheckout });
}
