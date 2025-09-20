import { APL } from "@saleor/app-sdk/APL";
import { DynamoAPL } from "@saleor/app-sdk/APL/dynamodb";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

import { env } from "./env";
import { HttpsEnforcingAPL } from "./https-enforcing-apl";

let baseApl: APL;

switch (env.APL) {
  case "dynamodb": {
    baseApl = DynamoAPL.create({
      table: dynamoMainTable,
    });

    break;
  }

  default: {
    baseApl = new FileAPL();
    break;
  }
}

// Wrap the base APL with HTTPS enforcement
export const apl = new HttpsEnforcingAPL(baseApl);

export const saleorApp = new SaleorApp({
  apl,
});
