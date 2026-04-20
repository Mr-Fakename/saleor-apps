import { router } from "./trpc-server";
import { b2bCustomersRouter } from "./b2b-customers.router";

export const appRouter = router({
  b2bCustomers: b2bCustomersRouter,
});

export type AppRouter = typeof appRouter;
