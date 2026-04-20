import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";
import { err, ok, Result } from "neverthrow";
import { Client } from "urql";

import { UnknownError } from "@/lib/errors";
import {
  GetUserDocument,
  GetUserOrdersDocument,
  GetUserQuery,
  GetUserOrdersQuery,
  GetProductsByIdsDocument,
  GetProductsByIdsQuery,
  GetOrderByIdDocument,
  GetOrderByIdQuery,
  GetRecentOrdersDocument,
  GetRecentOrdersQuery,
  SearchOrdersDocument,
  SearchOrdersQuery,
} from "@/generated/graphql";

export class SaleorClient {
  private client: Client;

  constructor(args: { saleorApiUrl: string; token?: string }) {
    this.client = createGraphQLClient({
      saleorApiUrl: args.saleorApiUrl,
      token: args.token,
    });
  }

  async getUser(args: {
    userId: string;
  }): Promise<Result<GetUserQuery["user"], InstanceType<typeof UnknownError>>> {
    try {
      const result = await this.client
        .query(GetUserDocument, {
          id: args.userId,
        })
        .toPromise();

      if (result.error) {
        return err(new UnknownError("Failed to fetch user", { cause: result.error }));
      }

      if (!result.data?.user) {
        return err(new UnknownError("User not found"));
      }

      return ok(result.data.user);
    } catch (error) {
      return err(new UnknownError("Failed to fetch user", { cause: error }));
    }
  }

  async getUserOrders(args: {
    userId: string;
    first?: number;
  }): Promise<Result<GetUserOrdersQuery["user"], InstanceType<typeof UnknownError>>> {
    try {
      const result = await this.client
        .query(GetUserOrdersDocument, {
          userId: args.userId,
          first: args.first ?? 50,
        })
        .toPromise();

      if (result.error) {
        return err(new UnknownError("Failed to fetch user orders", { cause: result.error }));
      }

      if (!result.data?.user) {
        return err(new UnknownError("User not found"));
      }

      return ok(result.data.user);
    } catch (error) {
      return err(new UnknownError("Failed to fetch user orders", { cause: error }));
    }
  }

  async getProductsByIds(args: {
    productIds: string[];
    channel: string;
  }): Promise<
    Result<GetProductsByIdsQuery["products"], InstanceType<typeof UnknownError>>
  > {
    try {
      const result = await this.client
        .query(GetProductsByIdsDocument, {
          ids: args.productIds,
          channel: args.channel,
        })
        .toPromise();

      if (result.error) {
        return err(
          new UnknownError("Failed to fetch products", { cause: result.error })
        );
      }

      if (!result.data?.products) {
        return err(new UnknownError("Products not found"));
      }

      return ok(result.data.products);
    } catch (error) {
      return err(new UnknownError("Failed to fetch products", { cause: error }));
    }
  }

  async getOrderById(args: {
    orderId: string;
  }): Promise<Result<GetOrderByIdQuery["order"], InstanceType<typeof UnknownError>>> {
    try {
      const result = await this.client
        .query(GetOrderByIdDocument, {
          id: args.orderId,
        })
        .toPromise();

      if (result.error) {
        return err(new UnknownError("Failed to fetch order", { cause: result.error }));
      }

      if (!result.data?.order) {
        return err(new UnknownError("Order not found"));
      }

      return ok(result.data.order);
    } catch (error) {
      return err(new UnknownError("Failed to fetch order", { cause: error }));
    }
  }

  async getRecentOrders(args: {
    first: number;
    channel?: string;
  }): Promise<Result<GetRecentOrdersQuery["orders"], InstanceType<typeof UnknownError>>> {
    try {
      const result = await this.client
        .query(GetRecentOrdersDocument, {
          first: args.first,
          channel: args.channel,
        })
        .toPromise();

      if (result.error) {
        return err(new UnknownError("Failed to fetch recent orders", { cause: result.error }));
      }

      if (!result.data?.orders) {
        return err(new UnknownError("Orders not found"));
      }

      return ok(result.data.orders);
    } catch (error) {
      return err(new UnknownError("Failed to fetch recent orders", { cause: error }));
    }
  }

  async searchOrders(args: {
    query: string;
    first: number;
  }): Promise<Result<SearchOrdersQuery["orders"], InstanceType<typeof UnknownError>>> {
    try {
      const result = await this.client
        .query(SearchOrdersDocument, {
          filter: {
            search: args.query,
          },
          first: args.first,
        })
        .toPromise();

      if (result.error) {
        return err(new UnknownError("Failed to search orders", { cause: result.error }));
      }

      if (!result.data?.orders) {
        return err(new UnknownError("Orders not found"));
      }

      return ok(result.data.orders);
    } catch (error) {
      return err(new UnknownError("Failed to search orders", { cause: error }));
    }
  }
}

export const createSaleorClient = (args: { saleorApiUrl: string; token?: string }) => {
  return new SaleorClient(args);
};
