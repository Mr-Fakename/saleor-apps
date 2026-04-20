import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";

export default createManifestHandler({
  async manifestFactory({ appBaseUrl }) {
    const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
    const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

    const manifest: AppManifest = {
      about: "B2B Tax Manager — VAT validation, tax exemption, and reverse charge for EU B2B transactions",
      appUrl: iframeBaseUrl,
      author: "Daybreak Development",
      brand: {
        logo: {
          default: `${apiBaseURL}/logo.png`,
        },
      },
      dataPrivacyUrl: "https://saleor.io/legal/privacy/",
      extensions: [],
      homepageUrl: "https://github.com/saleor/apps",
      id: "saleor.app.b2b-tax-manager",
      name: "B2B Tax Manager",
      permissions: ["MANAGE_TAXES", "MANAGE_CHECKOUTS", "MANAGE_USERS"],
      requiredSaleorVersion: ">=3.19 <4",
      supportUrl: "https://github.com/saleor/apps/discussions",
      tokenTargetUrl: `${apiBaseURL}/api/register`,
      version: "1.0.0",
      webhooks: [
        {
          name: "Checkout Updated",
          asyncEvents: ["CHECKOUT_UPDATED"],
          query: `
            subscription CheckoutUpdated {
              event {
                ... on CheckoutUpdated {
                  checkout {
                    id
                    email
                    billingAddress {
                      country {
                        code
                      }
                      companyName
                    }
                    metadata {
                      key
                      value
                    }
                  }
                }
              }
            }
          `,
          targetUrl: `${apiBaseURL}/api/webhooks/checkout-updated`,
        },
        {
          name: "Order Created",
          asyncEvents: ["ORDER_CREATED"],
          query: `
            subscription OrderCreated {
              event {
                ... on OrderCreated {
                  order {
                    id
                    number
                    billingAddress {
                      country {
                        code
                      }
                      companyName
                    }
                    metadata {
                      key
                      value
                    }
                  }
                }
              }
            }
          `,
          targetUrl: `${apiBaseURL}/api/webhooks/order-created`,
        },
      ],
    };

    return manifest;
  },
});
