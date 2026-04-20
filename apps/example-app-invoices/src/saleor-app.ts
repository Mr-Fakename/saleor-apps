import { APL, FileAPL, SaleorCloudAPL, UpstashAPL } from "@saleor/app-sdk/APL";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";
import { HttpsEnforcingAPL } from "./lib/https-enforcing-apl";

const aplType = process.env.APL ?? "file";

let baseApl: APL;

switch (aplType) {
  case "upstash":
    baseApl = new UpstashAPL();

    break;
  case "file":
    baseApl = new FileAPL();

    break;
  case "rest": {
    if (!process.env.REST_APL_ENDPOINT || !process.env.REST_APL_TOKEN) {
      throw new Error("Rest APL is not configured - missing env variables. Check saleor-app.ts");
    }

    baseApl = new SaleorCloudAPL({
      resourceUrl: process.env.REST_APL_ENDPOINT,
      token: process.env.REST_APL_TOKEN,
    });

    break;
  }
  default: {
    throw new Error("Invalid APL config, ");
  }
}

// Wrap the base APL with HTTPS enforcement to handle HTTP/HTTPS URL mismatches
const apl = new HttpsEnforcingAPL(baseApl);

export const saleorApp = new SaleorApp({
  apl,
});

export const REQUIRED_SALEOR_VERSION = ">=3.10 <4";
