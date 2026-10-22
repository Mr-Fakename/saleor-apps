import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import {
  mockedSaleorAppId,
  mockedSaleorChannelId,
  mockedSaleorTransactionId,
} from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRefundId } from "@/__tests__/mocks/mocked-stripe-refund-id";
import { mockedStripeRefundsApi } from "@/__tests__/mocks/mocked-stripe-refunds-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedTransactionRefundRequestedEvent } from "@/__tests__/mocks/saleor-events/transaction-refund-request-event";
import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { TransactionEventTypeEnum } from "@/generated/graphql";
import { appContextContainer } from "@/lib/app-context";
import { generateRefundStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { createStripeRefundId } from "@/modules/stripe/stripe-refund-id";
import { IStripeRefundsApiFactory } from "@/modules/stripe/types";
import { RefundFailureResult } from "@/modules/transaction-result/refund-result";

import { RefundAlreadyRecordedError, RefundRequestChangedError } from "./refund-refusal-errors";
import { TransactionRefundRequestedUseCase } from "./use-case";
import { TransactionRefundRequestedUseCaseResponses } from "./use-case-response";

describe("TransactionRefundRequestedUseCase", () => {
  const stripeRefundsApiFactory = {
    create: () => mockedStripeRefundsApi,
  } satisfies IStripeRefundsApiFactory;

  it("Calls Stripe Refunds API to create refund and returns Success when refund is created successfully", async () => {
    const spy = vi.spyOn(mockedStripeRefundsApi, "createRefund").mockImplementationOnce(async () =>
      ok({
        status: "succeeded",
        amount: 100,
        currency: "usd",
        id: mockedStripeRefundId.toString(),
      } as Stripe.Refund),
    );

    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: getMockedTransactionRefundRequestedEvent(),
    });

    expect(result._unsafeUnwrap()).toBeInstanceOf(
      TransactionRefundRequestedUseCaseResponses.Success,
    );

    expect(spy).toHaveBeenCalledWith({
      paymentIntentId: mockedStripePaymentIntentId,
      stripeMoney: expect.any(StripeMoney),
      idempotencyKey: expect.any(String),
      // Only what stays the same for the life of the transaction (review Low 3).
      metadata: {
        saleor_transaction_id: "mocked-transaction-id",
      },
    });
  });

  it("Calls Stripe Refunds API to create refund and returns Failure with RefundFailureResult when refund creation fails", async () => {
    const spy = vi
      .spyOn(mockedStripeRefundsApi, "createRefund")
      .mockImplementationOnce(async () => err(new StripeAPIError("Error from stripe")));

    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: getMockedTransactionRefundRequestedEvent(),
    });

    expect(result._unsafeUnwrap()).toBeInstanceOf(
      TransactionRefundRequestedUseCaseResponses.Failure,
    );

    expect(spy).toHaveBeenCalledWith({
      paymentIntentId: mockedStripePaymentIntentId,
      stripeMoney: expect.any(StripeMoney),
      idempotencyKey: expect.any(String),
      // Only what stays the same for the life of the transaction (review Low 3).
      metadata: {
        saleor_transaction_id: "mocked-transaction-id",
      },
    });
  });

  it("Returns 'MissingConfigErrorResponse' if config not found for specified channel", async () => {
    const spy = vi
      .spyOn(mockedAppConfigRepo, "getStripeConfig")
      .mockImplementationOnce(async () => ok(null));

    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    const responsePayload = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: getMockedTransactionRefundRequestedEvent(),
    });

    const err = responsePayload._unsafeUnwrapErr();

    expect(spy).toHaveBeenCalledOnce();

    expect(err).toBeInstanceOf(AppIsNotConfiguredResponse);
  });

  it("Returns 'MalformedRequestResponse' when currency coming from Saleor is not supported", async () => {
    const saleorEvent = {
      ...getMockedTransactionRefundRequestedEvent(),
      action: {
        amount: 100,
        currency: "abc",
      },
    };
    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    const response = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: saleorEvent,
    });

    expect(response._unsafeUnwrapErr()).toBeInstanceOf(MalformedRequestResponse);
  });

  it("Returns 'BrokenAppResponse' when currency coming from Stripe is not supported", async () => {
    vi.spyOn(mockedStripeRefundsApi, "createRefund").mockImplementation(async () =>
      ok({
        amount: 100,
        currency: "abc",
      } as Stripe.Refund),
    );
    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    const response = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: getMockedTransactionRefundRequestedEvent(),
    });

    expect(response._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it("Throws error when Saleor event has no transaction", async () => {
    const saleorEvent = { ...getMockedTransactionRefundRequestedEvent(), transaction: null };

    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    await expect(
      uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[MissingTransactionError: Transaction not found in event]`,
    );
  });

  /*
   * Regression NR-32 (payments review 2026-10-21, A2d): if Stripe creates the refund but
   * Saleor never gets the answer (5xx -> Saleor re-sends the same delivery; timeout ->
   * failure recorded and staff retry), a retry must not create a second refund.
   */
  describe("Stripe idempotency key (NR-32)", () => {
    const refundCreated = (amount = 100) =>
      ok({
        status: "pending",
        amount,
        currency: "usd",
        id: mockedStripeRefundId.toString(),
        created: Math.floor(Date.now() / 1000),
      } as Stripe.Refund);

    const keyUsedFor = async (
      event: ReturnType<typeof getMockedTransactionRefundRequestedEvent>,
    ) => {
      const spy = vi
        .spyOn(mockedStripeRefundsApi, "createRefund")
        .mockImplementationOnce(async () => refundCreated());

      const uc = new TransactionRefundRequestedUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripeRefundsApiFactory,
      });

      await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event,
      });

      expect(spy).toHaveBeenCalledOnce();

      const key = spy.mock.calls[0][0].idempotencyKey;

      spy.mockClear();

      return key;
    };

    const withAmount = (amount: number) => ({
      ...getMockedTransactionRefundRequestedEvent(),
      action: { amount, currency: "USD" },
    });

    it("passes an idempotency key to Stripe", async () => {
      const key = await keyUsedFor(getMockedTransactionRefundRequestedEvent());

      expect(key).toStrictEqual(expect.any(String));
      expect(key?.length).toBeGreaterThan(0);
      expect(key?.length).toBeLessThanOrEqual(255);
    });

    it("uses the same key when Saleor re-sends the same refund request", async () => {
      const first = await keyUsedFor(getMockedTransactionRefundRequestedEvent());
      const retry = await keyUsedFor(getMockedTransactionRefundRequestedEvent());

      expect(first).toStrictEqual(expect.any(String));
      expect(retry).toBe(first);
    });

    it("keys on Stripe minor units, so float noise in the Saleor amount does not change it", async () => {
      const exact = await keyUsedFor(withAmount(0.3));
      const floatSum = await keyUsedFor(withAmount(0.1 + 0.2)); // 0.30000000000000004

      expect(exact).toStrictEqual(expect.any(String));
      expect(floatSum).toBe(exact);
    });

    it("uses a different key for another amount", async () => {
      const full = await keyUsedFor(withAmount(100));
      const partial = await keyUsedFor(withAmount(40.5));

      expect(full).toStrictEqual(expect.any(String));
      expect(partial).toStrictEqual(expect.any(String));
      expect(partial).not.toBe(full);
    });

    it("uses a different key for another transaction or PaymentIntent", async () => {
      const base = getMockedTransactionRefundRequestedEvent();
      const baseKey = await keyUsedFor(base);

      const otherTransaction = await keyUsedFor({
        ...base,
        transaction: base.transaction && {
          ...base.transaction,
          id: "VHJhbnNhY3Rpb25JdGVtOjk5",
        },
      });
      const otherPaymentIntent = await keyUsedFor({
        ...base,
        transaction: base.transaction && { ...base.transaction, pspReference: "pi_other" },
      });

      expect(baseKey).toStrictEqual(expect.any(String));
      expect(new Set([baseKey, otherTransaction, otherPaymentIntent]).size).toBe(3);
    });

    it("reports Success with the refund Stripe returns for a replayed key", async () => {
      // Stripe answers a replayed key with the refund it created the first time.
      vi.spyOn(mockedStripeRefundsApi, "createRefund").mockImplementationOnce(async () =>
        ok({
          status: "succeeded",
          amount: 100,
          currency: "usd",
          id: mockedStripeRefundId.toString(),
          created: Math.floor(Date.now() / 1000) - 3600,
        } as Stripe.Refund),
      );

      const uc = new TransactionRefundRequestedUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripeRefundsApiFactory,
      });

      const result = await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: getMockedTransactionRefundRequestedEvent(),
      });

      const response = result._unsafeUnwrap();

      expect(response).toBeInstanceOf(TransactionRefundRequestedUseCaseResponses.Success);
      expect(
        response instanceof TransactionRefundRequestedUseCaseResponses.Success &&
          response.stripeRefundId,
      ).toBe(mockedStripeRefundId);
    });

    /*
     * Review M3 (payments review 2026-10-22): the v1 key has no per-request field, so two
     * genuine refunds of the same amount on one transaction within 24 h moved money once.
     * TRANSACTION_REFUND_REQUESTED carries `grantedRefund { id }`, the same across retries of
     * one refund request and different for the next one. Saleors keep sending the old payload
     * until the webhook is re-registered, so both payload shapes must stay safe.
     */
    describe("keyed per refund request on Saleor's granted refund (M3)", () => {
      /** The v1 key of the mocked event, pinned: a deploy must not change it under a retry. */
      const MOCKED_EVENT_V1_KEY =
        "saleor-refund-v1-c087da1fe1742af755b13790dc32ea9248adda5095af0316bbdae50a5d4e113f";

      const withGrantedRefund = (grantedRefund: { id: string } | null) => ({
        ...getMockedTransactionRefundRequestedEvent(),
        grantedRefund,
      });

      it("keeps the v1 key when the payload has no grantedRefund (webhook not re-registered yet)", async () => {
        const oldPayload = getMockedTransactionRefundRequestedEvent();

        expect(oldPayload).not.toHaveProperty("grantedRefund");
        expect(await keyUsedFor(oldPayload)).toBe(MOCKED_EVENT_V1_KEY);
      });

      it("keeps the v1 key for a refund requested without a granted refund", async () => {
        expect(await keyUsedFor(withGrantedRefund(null))).toBe(MOCKED_EVENT_V1_KEY);
      });

      it("keeps the v1 key when the granted refund id stands for no granted refund", async () => {
        // base64("OrderGrantedRefund:None"): what a GlobalID resolver makes of a missing node.
        expect(
          await keyUsedFor(withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOk5vbmU=" })),
        ).toBe(MOCKED_EVENT_V1_KEY);
      });

      it("uses a v2 key when Saleor sends the granted refund", async () => {
        const key = await keyUsedFor(withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }));

        expect(key).toMatch(/^saleor-refund-v2-[0-9a-f]{64}$/);
      });

      it("gives two granted refunds of the same amount on one transaction different keys", async () => {
        const first = await keyUsedFor(withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }));
        const second = await keyUsedFor(withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjI=" }));

        expect(first).toStrictEqual(expect.any(String));
        expect(second).toStrictEqual(expect.any(String));
        expect(second).not.toBe(first);
      });

      it("gives a retry of the same granted refund the same key", async () => {
        const first = await keyUsedFor(withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }));
        const retry = await keyUsedFor(withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }));

        expect(first).toStrictEqual(expect.any(String));
        expect(retry).toBe(first);
      });

      /*
       * Review round 2 (HIGH): Stripe creates re_1, Saleor's call times out, the granted
       * refund goes to FAILURE, staff edit its amount (Saleor allows it in NONE/FAILURE) and
       * retry. A key that contains the amount is new -> a second refund. The key stays the
       * same, so Stripe sees the same key with other parameters and refuses (below).
       */
      it("keeps the key of a granted refund when staff change its amount or currency", async () => {
        const first = await keyUsedFor({
          ...withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }),
          action: { amount: 100, currency: "USD" },
        });
        const editedAmount = await keyUsedFor({
          ...withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }),
          action: { amount: 40.5, currency: "USD" },
        });
        const editedCurrency = await keyUsedFor({
          ...withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }),
          action: { amount: 100, currency: "EUR" },
        });

        expect(first).toMatch(/^saleor-refund-v2-[0-9a-f]{64}$/);
        expect(editedAmount).toBe(first);
        expect(editedCurrency).toBe(first);
      });

      it("refuses with REFUND_FAILURE when Stripe rejects the key reused with another amount", async () => {
        vi.spyOn(mockedStripeRefundsApi, "createRefund").mockImplementationOnce(async () =>
          err(
            new Stripe.errors.StripeIdempotencyError({
              type: "idempotency_error",
              message:
                "Keys for idempotent requests can only be used with the same parameters they were first used with.",
            }),
          ),
        );

        const uc = new TransactionRefundRequestedUseCase({
          appConfigRepo: mockedAppConfigRepo,
          stripeRefundsApiFactory,
        });

        const result = await uc.execute({
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          event: {
            ...withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }),
            action: { amount: 40.5, currency: "USD" },
          },
        });

        const response = result._unsafeUnwrap();

        expect(response).toBeInstanceOf(TransactionRefundRequestedUseCaseResponses.Failure);

        const failure =
          response instanceof TransactionRefundRequestedUseCaseResponses.Failure
            ? response
            : undefined;

        expect(failure?.transactionResult).toBeInstanceOf(RefundFailureResult);
        expect(failure?.error).toBeInstanceOf(RefundRequestChangedError);
        expect(failure?.message).toContain("amount changed after a possibly-successful attempt");
        expect(failure?.message).toContain("create a new granted refund");
      });

      /*
       * Review round 3 (P1): Saleor saves the answer with include_in_calculations=True and
       * groups refund events by pspReference; a REFUND_FAILURE under the PaymentIntent newer
       * than the refund the earlier attempt may have made drops that refund from
       * refundedAmount and invites staff to refund again.
       */
      it("answers that refusal without pspReference, so Saleor cannot drop an earlier refund of the PaymentIntent", async () => {
        vi.spyOn(appContextContainer, "getContextValue").mockReturnValue({ stripeEnv: "TEST" });
        vi.spyOn(mockedStripeRefundsApi, "createRefund").mockImplementationOnce(async () =>
          err(
            new Stripe.errors.StripeIdempotencyError({
              type: "idempotency_error",
              message:
                "Keys for idempotent requests can only be used with the same parameters they were first used with.",
            }),
          ),
        );

        const result = await new TransactionRefundRequestedUseCase({
          appConfigRepo: mockedAppConfigRepo,
          stripeRefundsApiFactory,
        }).execute({
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          event: {
            ...withGrantedRefund({ id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" }),
            action: { amount: 40.5, currency: "USD" },
          },
        });

        const response = result._unsafeUnwrap();

        expect(response).toBeInstanceOf(TransactionRefundRequestedUseCaseResponses.Failure);
        expect(
          response instanceof TransactionRefundRequestedUseCaseResponses.Failure && response.error,
        ).toBeInstanceOf(RefundRequestChangedError);

        const body = await response.getResponse().json();

        expect(body).toMatchObject({ result: "REFUND_FAILURE" });
        expect(body).not.toHaveProperty("pspReference");
      });
    });

    /*
     * Review round 2 (MEDIUM): with the v1 key, a second refund of the same amount on the
     * same transaction within 24 h gets the first refund back from Stripe and moved no
     * money, yet was reported as a success. When Saleor already recorded that refund, the
     * request cannot be a retry still waiting for its answer: it is refused.
     */
    describe("an existing refund that Saleor already recorded (round 2)", () => {
      const HOUR = 3600;
      const REPLAYED_REFUND_ID = mockedStripeRefundId.toString();

      const stripeAnswersWithRefund = (createdSecondsAgo: number) =>
        vi.spyOn(mockedStripeRefundsApi, "createRefund").mockImplementationOnce(async () =>
          ok({
            status: "succeeded",
            amount: 100_00,
            currency: "usd",
            id: REPLAYED_REFUND_ID,
            created: Math.floor(Date.now() / 1000) - createdSecondsAgo,
          } as Stripe.Refund),
        );

      const withRecordedEvents = (
        events: Array<{
          type: TransactionEventTypeEnum;
          pspReference: string;
          externalUrl: string;
        }>,
      ) => {
        const base = getMockedTransactionRefundRequestedEvent();

        return {
          ...base,
          transaction: base.transaction && { ...base.transaction, events },
        };
      };

      /** How StripeRefundHandler reports a refund the app created: under the PaymentIntent. */
      const recordedAppRefund = (refundId: string, type: TransactionEventTypeEnum) => ({
        type,
        pspReference: mockedStripePaymentIntentId.toString(),
        externalUrl: generateRefundStripeDashboardUrl(createStripeRefundId(refundId), "TEST"),
      });

      const execute = (event: ReturnType<typeof withRecordedEvents>) =>
        new TransactionRefundRequestedUseCase({
          appConfigRepo: mockedAppConfigRepo,
          stripeRefundsApiFactory,
        }).execute({ saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId, event });

      const failureOf = (result: Awaited<ReturnType<typeof execute>>) => {
        const response = result._unsafeUnwrap();

        expect(response).toBeInstanceOf(TransactionRefundRequestedUseCaseResponses.Failure);

        return response instanceof TransactionRefundRequestedUseCaseResponses.Failure
          ? response
          : undefined;
      };

      it("refuses an identical refund when Stripe returns a refund Saleor recorded under the PaymentIntent", async () => {
        stripeAnswersWithRefund(HOUR);

        const result = await execute(
          withRecordedEvents([
            recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_REQUEST"),
            recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_SUCCESS"),
          ]),
        );

        const failure = failureOf(result);

        expect(failure?.transactionResult).toBeInstanceOf(RefundFailureResult);
        expect(failure?.error).toBeInstanceOf(RefundAlreadyRecordedError);
        expect(failure?.message).toContain("identical refund within 24 h");
        expect(failure?.message).toContain("use a granted refund");
      });

      it("refuses an identical refund when Saleor recorded the refund under its own ID", async () => {
        stripeAnswersWithRefund(HOUR);

        const result = await execute(
          withRecordedEvents([
            {
              type: "REFUND_SUCCESS",
              pspReference: REPLAYED_REFUND_ID,
              externalUrl: "",
            },
          ]),
        );

        const failure = failureOf(result);

        expect(failure?.transactionResult).toBeInstanceOf(RefundFailureResult);
        expect(failure?.error).toBeInstanceOf(RefundAlreadyRecordedError);
      });

      /*
       * Review round 3 (P1): under the PaymentIntent's pspReference this REFUND_FAILURE is
       * newer than the REFUND_SUCCESS Saleor recorded for the very refund Stripe returned, so
       * Saleor would drop that real refund from refundedAmount.
       */
      it("answers that refusal without pspReference, so Saleor keeps the refund it recorded", async () => {
        vi.spyOn(appContextContainer, "getContextValue").mockReturnValue({ stripeEnv: "TEST" });
        stripeAnswersWithRefund(HOUR);

        const result = await execute(
          withRecordedEvents([
            recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_REQUEST"),
            recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_SUCCESS"),
          ]),
        );

        const failure = failureOf(result);

        expect(failure?.error).toBeInstanceOf(RefundAlreadyRecordedError);

        const body = await failure?.getResponse().json();

        expect(body).toMatchObject({ result: "REFUND_FAILURE" });
        expect(body).not.toHaveProperty("pspReference");
      });

      it.each<{
        case: string;
        events: Array<{
          type: TransactionEventTypeEnum;
          pspReference: string;
          externalUrl: string;
        }>;
      }>([
        {
          case: "the earlier attempt timed out and its success is not recorded yet",
          events: [
            recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_REQUEST"),
            recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_FAILURE"),
          ],
        },
        {
          case: "only another refund of the transaction is recorded",
          events: [recordedAppRefund("re_OTHER_REFUND", "REFUND_SUCCESS")],
        },
        { case: "nothing is recorded", events: [] },
      ])("reports a genuine retry as a success when $case", async ({ events }) => {
        stripeAnswersWithRefund(HOUR);

        const result = await execute(withRecordedEvents(events));

        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionRefundRequestedUseCaseResponses.Success,
        );
      });

      /*
       * With a granted refund (v2 key) a replay is always a retry of that same granted
       * refund, never a second refund; "use a granted refund" would invite staff to refund
       * the customer twice. Only the v1 path (no granted refund) is refused.
       */
      it("keeps reporting a granted refund's replay as a success, even once Saleor recorded it", async () => {
        stripeAnswersWithRefund(HOUR);

        const result = await execute({
          ...withRecordedEvents([recordedAppRefund(REPLAYED_REFUND_ID, "REFUND_SUCCESS")]),
          grantedRefund: { id: "T3JkZXJHcmFudGVkUmVmdW5kOjE=" },
        });

        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionRefundRequestedUseCaseResponses.Success,
        );
      });

      it("reports a new refund as a success even when Saleor recorded another one", async () => {
        stripeAnswersWithRefund(0);

        const result = await execute(
          withRecordedEvents([recordedAppRefund("re_OTHER_REFUND", "REFUND_SUCCESS")]),
        );

        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionRefundRequestedUseCaseResponses.Success,
        );
      });

      it("reports a replay as a success when the payload has no events (webhook not re-registered yet)", async () => {
        stripeAnswersWithRefund(HOUR);

        const legacyPayload = getMockedTransactionRefundRequestedEvent();

        expect(legacyPayload.transaction).not.toHaveProperty("events");

        const result = await new TransactionRefundRequestedUseCase({
          appConfigRepo: mockedAppConfigRepo,
          stripeRefundsApiFactory,
        }).execute({
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          event: legacyPayload,
        });

        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionRefundRequestedUseCaseResponses.Success,
        );
      });
    });

    /*
     * Review Low 3: completing the checkout moves the transaction to the order, so a retry
     * after completion saw saleor_source_id switch from the checkout to the order. Stripe
     * rejects a reused key with other parameters (idempotency_error): the retry failed.
     */
    it("sends the same refund request before and after the checkout became an order (Low 3)", async () => {
      const onCheckout = getMockedTransactionRefundRequestedEvent();
      const onOrder = {
        ...onCheckout,
        transaction: onCheckout.transaction && {
          ...onCheckout.transaction,
          checkout: null,
          order: {
            id: "T3JkZXI6MQ==",
            channel: { id: mockedSaleorChannelId, slug: "channel-slug" },
          },
        },
      };

      const spy = vi
        .spyOn(mockedStripeRefundsApi, "createRefund")
        .mockImplementation(async () => refundCreated());

      const uc = new TransactionRefundRequestedUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripeRefundsApiFactory,
      });

      for (const event of [onCheckout, onOrder]) {
        await uc.execute({ saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId, event });
      }

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1][0]).toStrictEqual(spy.mock.calls[0][0]);
    });
  });

  it("Throws error when Saleor event has no channel for Saleor Checkout or Order", async () => {
    const saleorEvent = {
      ...getMockedTransactionRefundRequestedEvent(),
      transaction: {
        checkout: null,
        order: null,
        pspReference: mockedStripePaymentIntentId,
        id: mockedSaleorTransactionId,
      },
    };

    const uc = new TransactionRefundRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripeRefundsApiFactory,
    });

    await expect(
      uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[MissingChannelIdError: Channel ID not found in event Checkout or Order]`,
    );
  });
});
