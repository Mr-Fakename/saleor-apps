import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { StripeMoney } from "@/modules/stripe/stripe-money";

import {
  CheckoutPaymentState,
  CheckoutPaymentStateTransaction,
} from "./checkout-payment-state-fetcher";

const CurrencyMismatchError = BaseError.subclass("CheckoutAmountDue.CurrencyMismatchError", {
  props: {
    _internalName: "CheckoutAmountDue.CurrencyMismatchError" as const,
  },
});

const PaymentPendingError = BaseError.subclass("CheckoutAmountDue.PaymentPendingError", {
  props: {
    _internalName: "CheckoutAmountDue.PaymentPendingError" as const,
  },
});

const ForeignCurrencyHeldError = BaseError.subclass("CheckoutAmountDue.ForeignCurrencyHeldError", {
  props: {
    _internalName: "CheckoutAmountDue.ForeignCurrencyHeldError" as const,
  },
});

const InvalidAmountError = BaseError.subclass("CheckoutAmountDue.InvalidAmountError", {
  props: {
    _internalName: "CheckoutAmountDue.InvalidAmountError" as const,
  },
});

const NothingDueError = BaseError.subclass("CheckoutAmountDue.NothingDueError", {
  props: {
    _internalName: "CheckoutAmountDue.NothingDueError" as const,
  },
});

export const CheckoutAmountDueErrors = {
  CurrencyMismatchError,
  PaymentPendingError,
  ForeignCurrencyHeldError,
  InvalidAmountError,
  NothingDueError,
};

export type CheckoutAmountDueError = InstanceType<
  | typeof CurrencyMismatchError
  | typeof PaymentPendingError
  | typeof ForeignCurrencyHeldError
  | typeof InvalidAmountError
  | typeof NothingDueError
>;

export type CheckoutAmountDue = {
  /** What is left to pay on the checkout, in Stripe minor units. Always more than 0. */
  stripeMoney: StripeMoney;
  /** The checkout total, in Stripe minor units (for comparison with a requested amount). */
  checkoutTotal: StripeMoney;
  /** True when counted transactions already hold part of the total. */
  heldByCountedTransactions: boolean;
};

/**
 * The only amount the app writes to a PaymentIntent for a checkout (regressions NR-02, NR-31):
 *
 *   checkout.totalPrice.gross
 *   - Σ (chargedAmount + authorizedAmount) of the counted transactions
 *
 * `totalPrice` is already net of vouchers and gift cards: Saleor resolves it with
 * `calculate_checkout_total_with_gift_cards` (saleor/graphql/checkout/types.py,
 * `Checkout.resolve_total_price`). A charge moves money from `authorizedAmount` to
 * `chargedAmount` and a refund removes it from `chargedAmount`, so the sum is the money
 * a transaction holds right now.
 *
 * A transaction is counted unless `isExcluded` says it belongs to the PaymentIntent being
 * written. The amount is refused when:
 * - the checkout currency is not `currency`;
 * - a counted transaction still has a pending charge or authorization (what is owed
 *   cannot be known until it settles);
 * - a counted transaction holds money in another currency;
 * - nothing is left to pay.
 *
 * Saleor quantizes money to the currency precision, so float error from the subtraction
 * stays far below half a minor unit and StripeMoney's rounding removes it.
 */
export const resolveCheckoutAmountDue = (args: {
  checkout: Pick<CheckoutPaymentState, "totalPrice" | "transactions">;
  currency: string;
  isExcluded?: (transaction: CheckoutPaymentStateTransaction) => boolean;
}): Result<CheckoutAmountDue, CheckoutAmountDueError> => {
  const currency = args.currency.toLowerCase();
  const checkoutTotal = args.checkout.totalPrice.gross;

  if (checkoutTotal.currency.toLowerCase() !== currency) {
    return err(
      new CurrencyMismatchError(
        `Checkout currency ${checkoutTotal.currency} differs from payment currency ${currency}`,
      ),
    );
  }

  const isExcluded = args.isExcluded ?? (() => false);
  const counted = (args.checkout.transactions ?? []).filter((t) => !isExcluded(t));

  const hasPendingMoney = counted.some(
    (t) => t.chargePendingAmount.amount > 0 || t.authorizePendingAmount.amount > 0,
  );

  if (hasPendingMoney) {
    return err(new PaymentPendingError("Another transaction of the checkout is still pending"));
  }

  const held = counted.flatMap((t) => [t.chargedAmount, t.authorizedAmount]);

  if (held.some((m) => m.amount > 0 && m.currency.toLowerCase() !== currency)) {
    return err(new ForeignCurrencyHeldError("A transaction holds money in another currency"));
  }

  const amountDue = held.reduce((due, m) => due - m.amount, checkoutTotal.amount);

  const moneyResult = Result.combine([
    StripeMoney.createFromSaleorAmount({ amount: Math.max(amountDue, 0), currency }),
    StripeMoney.createFromSaleorAmount({ amount: checkoutTotal.amount, currency }),
  ]);

  if (moneyResult.isErr()) {
    return err(
      new InvalidAmountError("Failed to convert the checkout amount for Stripe", {
        cause: moneyResult.error,
      }),
    );
  }

  const [stripeMoney, checkoutTotalMoney] = moneyResult.value;

  if (stripeMoney.amount <= 0) {
    return err(new NothingDueError("Nothing left to pay on the checkout"));
  }

  return ok({
    stripeMoney,
    checkoutTotal: checkoutTotalMoney,
    heldByCountedTransactions: held.some((m) => m.amount > 0),
  });
};
