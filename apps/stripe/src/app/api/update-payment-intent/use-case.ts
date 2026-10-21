import { APL, AuthData } from "@saleor/app-sdk/APL";
import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import {
  CheckoutPaymentStateTransaction,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  mapStripeErrorToApiError,
  StripeInvalidRequestError,
} from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";

/**
 * Request contract of the storefront proxies (storefront/apps/<client>/src/app/api/stripe/
 * update-payment-intent/route.ts). `amount` is what the storefront BELIEVES the checkout
 * total is; it is only compared with the server value and logged, never written to Stripe.
 */
export const updatePaymentIntentRequestSchema = z.object({
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9_]+$/),
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  channelId: z.string().min(1).max(255),
  saleorApiUrl: z.string().min(1),
});

export type UpdatePaymentIntentRequest = z.infer<typeof updatePaymentIntentRequestSchema>;

export type UpdatePaymentIntentSuccess = {
  paymentIntentId: string;
  /** Minor units, as Stripe holds it after the call. */
  amount: number;
  currency: string;
  /** False when the PaymentIntent already held the server amount (no Stripe write). */
  updated: boolean;
};

const BadRequestError = BaseError.subclass("UpdatePaymentIntent.BadRequestError", {
  props: {
    _internalName: "UpdatePaymentIntent.BadRequestError" as const,
    httpStatus: 400,
    publicMessage: "Invalid request",
  },
});

const AppNotInstalledError = BaseError.subclass("UpdatePaymentIntent.AppNotInstalledError", {
  props: {
    _internalName: "UpdatePaymentIntent.AppNotInstalledError" as const,
    httpStatus: 401,
    publicMessage: "App not installed for this Saleor instance",
  },
});

const ForbiddenError = BaseError.subclass("UpdatePaymentIntent.ForbiddenError", {
  props: {
    _internalName: "UpdatePaymentIntent.ForbiddenError" as const,
    httpStatus: 403,
    publicMessage: "Payment intent does not belong to a checkout of this channel",
  },
});

const NotFoundError = BaseError.subclass("UpdatePaymentIntent.NotFoundError", {
  props: {
    _internalName: "UpdatePaymentIntent.NotFoundError" as const,
    httpStatus: 404,
    publicMessage: "Not found",
  },
});

const ConflictError = BaseError.subclass("UpdatePaymentIntent.ConflictError", {
  props: {
    _internalName: "UpdatePaymentIntent.ConflictError" as const,
    httpStatus: 409,
    publicMessage: "Payment intent cannot be updated",
  },
});

const InternalError = BaseError.subclass("UpdatePaymentIntent.InternalError", {
  props: {
    _internalName: "UpdatePaymentIntent.InternalError" as const,
    httpStatus: 500,
    publicMessage: "Internal server error",
  },
});

const UpstreamError = BaseError.subclass("UpdatePaymentIntent.UpstreamError", {
  props: {
    _internalName: "UpdatePaymentIntent.UpstreamError" as const,
    httpStatus: 502,
    publicMessage: "Upstream service request failed",
  },
});

export const UpdatePaymentIntentErrors = {
  BadRequestError,
  AppNotInstalledError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InternalError,
  UpstreamError,
};

export type UpdatePaymentIntentError = InstanceType<
  | typeof BadRequestError
  | typeof AppNotInstalledError
  | typeof ForbiddenError
  | typeof NotFoundError
  | typeof ConflictError
  | typeof InternalError
  | typeof UpstreamError
>;

/**
 * Statuses in which Stripe accepts a new `amount`. Anything else (processing,
 * requires_capture, succeeded, canceled) means money is already moving or done.
 * Stripe stays the final arbiter: a refused update surfaces as InternalError.
 */
const AMOUNT_UPDATABLE_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set<
  Stripe.PaymentIntent.Status
>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/**
 * Re-syncs an existing PaymentIntent to its checkout after the checkout total changed
 * (e.g. the dess PayPal-fee line was added or removed), without a new Saleor transaction.
 *
 * Saleor is the source of truth (regression NR-02): the amount written to Stripe is
 *
 *   checkout.totalPrice.gross
 *   - money already held by the checkout's OTHER transactions (charged + authorized)
 *
 * where "other" means not linked to this PaymentIntent (by pspReference or by the
 * PaymentIntent's `saleor_transaction_id` metadata). The request body never sets it.
 * The update is refused when another transaction still has pending money (the amount
 * owed is unknowable until it settles) or when nothing is left to charge.
 */
export class UpdatePaymentIntentAmountUseCase {
  private logger = createLogger("UpdatePaymentIntentAmountUseCase");
  private apl: Pick<APL, "get">;
  private appConfigRepo: AppConfigRepo;
  private stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
  private checkoutPaymentStateFetcherFactory: (authData: AuthData) => ICheckoutPaymentStateFetcher;

  constructor(deps: {
    apl: Pick<APL, "get">;
    appConfigRepo: AppConfigRepo;
    stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
    checkoutPaymentStateFetcherFactory: (authData: AuthData) => ICheckoutPaymentStateFetcher;
  }) {
    this.apl = deps.apl;
    this.appConfigRepo = deps.appConfigRepo;
    this.stripePaymentIntentsApiFactory = deps.stripePaymentIntentsApiFactory;
    this.checkoutPaymentStateFetcherFactory = deps.checkoutPaymentStateFetcherFactory;
  }

  async execute(
    input: UpdatePaymentIntentRequest,
  ): Promise<Result<UpdatePaymentIntentSuccess, UpdatePaymentIntentError>> {
    const saleorApiUrlResult = createSaleorApiUrl(input.saleorApiUrl);

    if (saleorApiUrlResult.isErr()) {
      return err(
        new BadRequestError("Invalid saleorApiUrl", {
          cause: saleorApiUrlResult.error,
          props: { publicMessage: "Invalid saleorApiUrl" },
        }),
      );
    }

    const saleorApiUrl = saleorApiUrlResult.value;

    const authData = await this.apl.get(saleorApiUrl);

    if (!authData) {
      return err(new AppNotInstalledError(`No auth data for ${saleorApiUrl}`));
    }

    const configResult = await this.appConfigRepo.getStripeConfig({
      channelId: input.channelId,
      appId: authData.appId,
      saleorApiUrl,
    });

    if (configResult.isErr()) {
      return err(
        new InternalError("Failed to get Stripe config", {
          cause: configResult.error,
          props: { publicMessage: "Failed to retrieve Stripe configuration" },
        }),
      );
    }

    if (!configResult.value) {
      return err(
        new NotFoundError(`No Stripe config for channel ${input.channelId}`, {
          props: { publicMessage: "Stripe not configured for this channel" },
        }),
      );
    }

    const stripeApi = this.stripePaymentIntentsApiFactory.create({
      key: configResult.value.restrictedKey,
    });
    const paymentIntentId = createStripePaymentIntentId(input.paymentIntentId);

    const paymentIntentResult = await stripeApi.getPaymentIntent({ id: paymentIntentId });

    if (paymentIntentResult.isErr()) {
      const stripeError = mapStripeErrorToApiError(paymentIntentResult.error);

      if (stripeError instanceof StripeInvalidRequestError) {
        return err(
          new NotFoundError("Stripe rejected the PaymentIntent lookup", {
            cause: stripeError,
            props: { publicMessage: "Payment intent not found" },
          }),
        );
      }

      return err(
        new UpstreamError("Failed to retrieve PaymentIntent from Stripe", {
          cause: stripeError,
          props: { publicMessage: "Failed to retrieve payment intent" },
        }),
      );
    }

    const paymentIntent = paymentIntentResult.value;
    const checkoutId = paymentIntent.metadata?.saleor_source_id;
    const linkedTransactionId = paymentIntent.metadata?.saleor_transaction_id;

    if (!checkoutId || paymentIntent.metadata?.saleor_source_type !== "Checkout") {
      return err(
        new ForbiddenError("PaymentIntent was not created by this app for a checkout", {
          props: { publicMessage: "Payment intent is not linked to a checkout" },
        }),
      );
    }

    if (paymentIntent.currency.toLowerCase() !== input.currency.toLowerCase()) {
      return err(
        new BadRequestError(
          `Currency ${input.currency} does not match PaymentIntent currency ${paymentIntent.currency}`,
          { props: { publicMessage: "Currency does not match the payment intent" } },
        ),
      );
    }

    if (!AMOUNT_UPDATABLE_STATUSES.has(paymentIntent.status)) {
      return err(
        new ConflictError(`PaymentIntent status ${paymentIntent.status} does not allow updates`, {
          props: { publicMessage: "Payment intent can no longer be updated" },
        }),
      );
    }

    const checkoutResult = await this.checkoutPaymentStateFetcherFactory(
      authData,
    ).fetchCheckoutPaymentState({ checkoutId });

    if (checkoutResult.isErr()) {
      return err(
        new UpstreamError("Failed to fetch checkout from Saleor", {
          cause: checkoutResult.error,
          props: { publicMessage: "Failed to fetch checkout" },
        }),
      );
    }

    const checkout = checkoutResult.value;

    if (!checkout) {
      return err(
        new NotFoundError(`Checkout ${checkoutId} not found`, {
          props: { publicMessage: "Checkout not found" },
        }),
      );
    }

    if (checkout.channel.id !== input.channelId) {
      return err(
        new ForbiddenError(
          `Checkout ${checkoutId} is in channel ${checkout.channel.id}, request named ${input.channelId}`,
        ),
      );
    }

    const isLinkedToThisPaymentIntent = (transaction: CheckoutPaymentStateTransaction) =>
      transaction.pspReference === paymentIntent.id ||
      (!!linkedTransactionId && transaction.id === linkedTransactionId);

    const transactions = checkout.transactions ?? [];

    if (!transactions.some(isLinkedToThisPaymentIntent)) {
      return err(
        new ForbiddenError(`Checkout ${checkoutId} holds no transaction for this PaymentIntent`),
      );
    }

    const checkoutTotal = checkout.totalPrice.gross;
    const currency = paymentIntent.currency.toLowerCase();

    if (checkoutTotal.currency.toLowerCase() !== currency) {
      return err(
        new ConflictError(
          `Checkout currency ${checkoutTotal.currency} differs from PaymentIntent currency ${currency}`,
          { props: { publicMessage: "Checkout currency does not match the payment intent" } },
        ),
      );
    }

    const otherTransactions = transactions.filter((t) => !isLinkedToThisPaymentIntent(t));

    const otherHasPendingMoney = otherTransactions.some(
      (t) => t.chargePendingAmount.amount > 0 || t.authorizePendingAmount.amount > 0,
    );

    if (otherHasPendingMoney) {
      return err(
        new ConflictError(`Checkout ${checkoutId} has another payment still pending`, {
          props: { publicMessage: "Checkout has another payment in progress" },
        }),
      );
    }

    const heldByOthers = otherTransactions.flatMap((t) => [t.chargedAmount, t.authorizedAmount]);

    if (heldByOthers.some((m) => m.amount > 0 && m.currency.toLowerCase() !== currency)) {
      return err(
        new ConflictError(`Checkout ${checkoutId} holds money in another currency`, {
          props: { publicMessage: "Checkout has payments in another currency" },
        }),
      );
    }

    /*
     * Saleor quantizes money to the currency precision, so float error from this
     * subtraction stays far below half a minor unit and StripeMoney's rounding to the
     * currency precision removes it.
     */
    const amountDue = heldByOthers.reduce((due, m) => due - m.amount, checkoutTotal.amount);

    const stripeMoneyResult = StripeMoney.createFromSaleorAmount({
      amount: Math.max(amountDue, 0),
      currency,
    });

    if (stripeMoneyResult.isErr()) {
      return err(
        new InternalError("Failed to convert the checkout amount for Stripe", {
          cause: stripeMoneyResult.error,
        }),
      );
    }

    const stripeMoney = stripeMoneyResult.value;

    if (stripeMoney.amount <= 0) {
      return err(
        new ConflictError(`Nothing left to charge on checkout ${checkoutId}`, {
          props: { publicMessage: "Nothing left to charge on this checkout" },
        }),
      );
    }

    const requestedMinor = StripeMoney.createFromSaleorAmount({
      amount: input.amount,
      currency,
    }).map((m) => m.amount);
    const checkoutTotalMinor = StripeMoney.createFromSaleorAmount({
      amount: checkoutTotal.amount,
      currency,
    }).map((m) => m.amount);

    if (
      requestedMinor.isErr() ||
      checkoutTotalMinor.isErr() ||
      requestedMinor.value !== checkoutTotalMinor.value
    ) {
      this.logger.warn("Requested amount differs from the Saleor checkout total; using the server amount", {
        paymentIntentId: paymentIntent.id,
        checkoutId,
        requestedAmount: input.amount,
        checkoutTotal: checkoutTotal.amount,
        amountDue: stripeMoney.amount,
      });
    }

    if (paymentIntent.amount === stripeMoney.amount) {
      this.logger.info("PaymentIntent already holds the checkout amount", {
        paymentIntentId: paymentIntent.id,
        checkoutId,
        amount: paymentIntent.amount,
        currency,
      });

      return ok({
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        updated: false,
      });
    }

    const updateResult = await stripeApi.updatePaymentIntent({
      id: paymentIntentId,
      stripeMoney,
    });

    if (updateResult.isErr()) {
      return err(
        new InternalError("Stripe updatePaymentIntent failed", {
          cause: mapStripeErrorToApiError(updateResult.error),
          props: { publicMessage: "Failed to update payment intent" },
        }),
      );
    }

    const updated = updateResult.value;

    this.logger.info("PaymentIntent amount synced to the checkout", {
      paymentIntentId: updated.id,
      checkoutId,
      previousAmount: paymentIntent.amount,
      amount: updated.amount,
      currency: updated.currency,
      heldByOtherTransactions: heldByOthers.some((m) => m.amount > 0),
    });

    return ok({
      paymentIntentId: updated.id,
      amount: updated.amount,
      currency: updated.currency,
      updated: true,
    });
  }
}
