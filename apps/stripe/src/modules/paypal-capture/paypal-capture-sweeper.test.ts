import { AuthData } from "@saleor/app-sdk/APL";
import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedConfigurationId } from "@/__tests__/mocks/constants";
import { InMemoryCaptureCoordinationRepo } from "@/__tests__/mocks/in-memory-capture-coordination-repo";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripeConfig } from "@/__tests__/mocks/mock-stripe-config";
import { mockedStripePublishableKey, mockedStripePublishableKeyTest } from "@/__tests__/mocks/mocked-stripe-publishable-key";
import { mockedStripeRestrictedKey, mockedStripeRestrictedKeyTest } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { a3dPaymentIntent, FakeCaptureSaleor } from "@/__tests__/mocks/paypal-capture-fixtures";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { mockStripeWebhookSecret } from "@/__tests__/mocks/stripe-webhook-secret";
import { AppRootConfig } from "@/modules/app-config/domain/app-root-config";
import { StripeConfig } from "@/modules/app-config/domain/stripe-config";
import { AppConfigRepoError } from "@/modules/app-config/repositories/app-config-repo";
import { StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

import { PaypalCaptureSweeper } from "./paypal-capture-sweeper";
import { IPaypalCaptureStripeApi } from "./types";

/*
 * A3d sweep, every 60 s (plus once 30 s after boot): under the DynamoDB lease, for each
 * installation and each Stripe account it is configured with, the Stripe search
 *   status:"requires_capture" AND metadata["saleor_payment_policy"]:"paypal-only"
 * then one coordinator check per PaymentIntent found (live re-read, DynamoDB record, Saleor
 * transaction(id) query: see PaypalCaptureCoordinator).
 */

const NOW = Date.parse("2026-10-23T10:00:00.000Z");

const secondConfig = StripeConfig.create({
  id: "2b6f3a1e-0000-4000-8000-000000000002",
  name: "test-config",
  publishableKey: mockedStripePublishableKeyTest,
  restrictedKey: mockedStripeRestrictedKeyTest,
  webhookSecret: mockStripeWebhookSecret,
  webhookId: "wh_2",
})._unsafeUnwrap();

const sameKeyConfig = StripeConfig.create({
  id: "2b6f3a1e-0000-4000-8000-000000000003",
  name: "same-key-config",
  publishableKey: mockedStripePublishableKey,
  restrictedKey: mockedStripeRestrictedKey,
  webhookSecret: mockStripeWebhookSecret,
  webhookId: "wh_3",
})._unsafeUnwrap();

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const apl = { getAll: vi.fn() };
const appConfigRepo = { getRootConfig: vi.fn() };
const coordinator = { checkPaymentIntent: vi.fn() };
const scheduleFollowUp = vi.fn();

let repo: InMemoryCaptureCoordinationRepo;
let stripeApis: Map<StripeRestrictedKey, IPaypalCaptureStripeApi & { search: ReturnType<typeof vi.fn> }>;
let saleorGateways: Map<string, FakeCaptureSaleor>;

const stripeApiFor = (key: StripeRestrictedKey, found: Stripe.PaymentIntent[] | "fails") => {
  const search = vi.fn(async () => (found === "fails" ? err(new Error("Stripe search down")) : ok(found)));
  const api = {
    search,
    searchPaymentIntentsAwaitingAppCapture: search,
    getPaymentIntent: vi.fn(),
  };

  stripeApis.set(key, api);

  return api;
};

const createSweeper = () =>
  new PaypalCaptureSweeper({
    apl,
    appConfigRepo,
    repo,
    coordinator,
    createStripeApi: (key) => {
      const api = stripeApis.get(key);

      if (!api) {
        throw new Error(`no fake Stripe for ${key}`);
      }

      return api;
    },
    createSaleorGateway: (authData: AuthData) => {
      const gateway = new FakeCaptureSaleor(null);

      saleorGateways.set(authData.saleorApiUrl, gateway);

      return gateway;
    },
    scheduleFollowUp,
    holderId: "worker-1",
    now: () => NOW,
    logger,
  });

const givenConfigs = (...configs: StripeConfig[]) =>
  appConfigRepo.getRootConfig.mockResolvedValue(
    ok(new AppRootConfig({}, Object.fromEntries(configs.map((config) => [config.id, config])))),
  );

const checkedIds = () => coordinator.checkPaymentIntent.mock.calls.map(([args]) => args.paymentIntentId);

describe("PaypalCaptureSweeper (A3d)", () => {
  beforeEach(() => {
    repo = new InMemoryCaptureCoordinationRepo();
    stripeApis = new Map();
    saleorGateways = new Map();
    apl.getAll.mockResolvedValue([mockAuthData]);
    coordinator.checkPaymentIntent.mockResolvedValue({ action: "waiting", reason: "checkout-not-completed" });
    Object.values(logger).forEach((fn) => fn.mockReset());
  });

  it("does nothing while another process holds the sweep lease", async () => {
    repo.lease = { holderId: "other-process", expiresAtMs: NOW + 30_000 };

    const summary = await createSweeper().sweep();

    expect(summary).toMatchObject({ lease: "held-elsewhere", checked: 0 });
    expect(apl.getAll).not.toHaveBeenCalled();
  });

  it("does nothing when the lease cannot be read", async () => {
    repo.failNext = "lease";

    const summary = await createSweeper().sweep();

    expect(summary).toMatchObject({ lease: "error", checked: 0 });
    expect(apl.getAll).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("takes an expired lease, then checks every PaymentIntent the search found, live", async () => {
    repo.lease = { holderId: "crashed-process", expiresAtMs: NOW - 1 };
    givenConfigs(mockedStripeConfig);

    const api = stripeApiFor(mockedStripeRestrictedKey, [a3dPaymentIntent("pi_one"), a3dPaymentIntent("pi_two")]);

    const summary = await createSweeper().sweep();

    expect(summary).toStrictEqual({ lease: "acquired", installations: 1, searched: 1, found: 2, checked: 2, failures: 0 });
    expect(repo.lease).toStrictEqual({ holderId: "worker-1", expiresAtMs: NOW + 90_000 });
    expect(api.search).toHaveBeenCalledOnce();
    expect(checkedIds()).toStrictEqual(["pi_one", "pi_two"]);
    expect(coordinator.checkPaymentIntent.mock.calls[0][0]).toMatchObject({
      access: { saleorApiUrl: mockedSaleorApiUrl, appId: mockAuthData.appId },
      stripe: api,
      saleor: saleorGateways.get(mockedSaleorApiUrl),
      trigger: "sweep",
    });
  });

  it("schedules a follow-up of the same PaymentIntent with its Stripe config", async () => {
    givenConfigs(mockedStripeConfig);
    stripeApiFor(mockedStripeRestrictedKey, [a3dPaymentIntent("pi_one")]);
    coordinator.checkPaymentIntent.mockImplementation(async (args) => {
      args.scheduleFollowUp(95_000);

      return { action: "charge-requested", attempt: 1, delivered: true };
    });

    await createSweeper().sweep();

    expect(scheduleFollowUp.mock.calls).toStrictEqual([
      [
        {
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockAuthData.appId,
          paymentIntentId: "pi_one",
          stripeConfig: { configId: mockedConfigurationId },
        },
        95_000,
      ],
    ]);
  });

  it("searches each Stripe account once, even when several configs share its key", async () => {
    givenConfigs(mockedStripeConfig, sameKeyConfig, secondConfig);

    const live = stripeApiFor(mockedStripeRestrictedKey, [a3dPaymentIntent("pi_live")]);
    const test = stripeApiFor(mockedStripeRestrictedKeyTest, [a3dPaymentIntent("pi_test")]);

    const summary = await createSweeper().sweep();

    expect(live.search).toHaveBeenCalledOnce();
    expect(test.search).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ searched: 2, found: 2, checked: 2 });
  });

  it("goes on with the other Stripe accounts when one search fails", async () => {
    givenConfigs(mockedStripeConfig, secondConfig);
    stripeApiFor(mockedStripeRestrictedKey, "fails");
    stripeApiFor(mockedStripeRestrictedKeyTest, [a3dPaymentIntent("pi_test")]);

    const summary = await createSweeper().sweep();

    expect(checkedIds()).toStrictEqual(["pi_test"]);
    expect(summary).toMatchObject({ failures: 1, checked: 1 });
    expect(logger.error).toHaveBeenCalled();
  });

  it("goes on with the next PaymentIntent when a check throws", async () => {
    givenConfigs(mockedStripeConfig);
    stripeApiFor(mockedStripeRestrictedKey, [a3dPaymentIntent("pi_one"), a3dPaymentIntent("pi_two")]);
    coordinator.checkPaymentIntent.mockRejectedValueOnce(new Error("bug"));

    const summary = await createSweeper().sweep();

    expect(checkedIds()).toStrictEqual(["pi_one", "pi_two"]);
    expect(summary).toMatchObject({ checked: 1, failures: 1 });
  });

  it("skips an installation whose configuration cannot be read", async () => {
    appConfigRepo.getRootConfig.mockResolvedValue(err(new AppConfigRepoError.FailureFetchingConfig("DynamoDB down")));

    const summary = await createSweeper().sweep();

    expect(summary).toMatchObject({ installations: 1, searched: 0, failures: 1 });
  });

  it("skips an APL entry with an invalid Saleor API URL", async () => {
    apl.getAll.mockResolvedValue([{ ...mockAuthData, saleorApiUrl: "not a url" }]);

    const summary = await createSweeper().sweep();

    expect(appConfigRepo.getRootConfig).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ installations: 1, failures: 1 });
  });

  it("reports an APL failure", async () => {
    apl.getAll.mockRejectedValue(new Error("APL down"));

    const summary = await createSweeper().sweep();

    expect(summary).toMatchObject({ lease: "acquired", installations: 0, failures: 1 });
  });
});
