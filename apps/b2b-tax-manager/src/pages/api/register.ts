import { createAppRegisterHandler } from "@saleor/app-sdk/handlers/next";
import { saleorApp } from "../../saleor-app";

export default createAppRegisterHandler({
  apl: saleorApp.apl,
  allowedSaleorUrls: [
    (url) => {
      const allowedPattern = process.env.ALLOWED_DOMAIN_PATTERN;
      if (allowedPattern) {
        return new RegExp(allowedPattern).test(url);
      }
      return true;
    },
  ],
});
