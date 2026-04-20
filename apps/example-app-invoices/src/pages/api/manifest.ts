import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";

import { wrapWithLoggerContext } from "../../logger-context";
import packageJson from "../../../package.json";
import { loggerContext } from "../../logger-context";
import { REQUIRED_SALEOR_VERSION } from "../../saleor-app";

export default wrapWithLoggerContext(
  createManifestHandler({
    async manifestFactory({ appBaseUrl }) {
      const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
      const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

      const manifest: AppManifest = {
        about:
          "An app that generates PDF invoices for Orders and stores them in Saleor file storage.",
        appUrl: iframeBaseUrl,
        author: "Daybreak Development",
        extensions: [],
        id: "saleor.app.invoices",
        name: "Invoices",
        permissions: ["MANAGE_ORDERS"],
        /**
         * Requires 3.10 due to invoices event payload - in previous versions, order reference was missing
         */
        requiredSaleorVersion: REQUIRED_SALEOR_VERSION,
        tokenTargetUrl: `${apiBaseURL}/api/register`,
        version: packageJson.version,
        webhooks: [
          {
            name: "Invoice requested",
            asyncEvents: ["INVOICE_REQUESTED"],
            query: `
              subscription InvoiceRequested {
                event {
                  ... on InvoiceRequested {
                    invoice {
                      id
                    }
                    order {
                      id
                      number
                      created
                      status
                      channel {
                        slug
                      }
                      lines {
                        productName
                        variantName
                        quantity
                        totalPrice {
                          currency
                          gross {
                            amount
                            currency
                          }
                          net {
                            amount
                            currency
                          }
                          tax {
                            amount
                            currency
                          }
                        }
                      }
                      total {
                        currency
                        gross {
                          amount
                          currency
                        }
                        net {
                          amount
                          currency
                        }
                        tax {
                          amount
                          currency
                        }
                      }
                      shippingPrice {
                        currency
                        gross {
                          amount
                          currency
                        }
                        net {
                          amount
                          currency
                        }
                        tax {
                          amount
                          currency
                        }
                      }
                      shippingMethodName
                      billingAddress {
                        id
                        country {
                          country
                          code
                        }
                        companyName
                        cityArea
                        countryArea
                        streetAddress1
                        streetAddress2
                        postalCode
                        phone
                        firstName
                        lastName
                        city
                      }
                      fulfillments {
                        created
                      }
                    }
                  }
                }
              }
            `,
            targetUrl: `${apiBaseURL}/api/webhooks/invoice-requested`,
          }
        ],
        brand: {
          logo: {
            default: `${apiBaseURL}/logo.png`,
          },
        },
      };

      return manifest;
    },
  }),
  loggerContext,
);
