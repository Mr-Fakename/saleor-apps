import { z } from "zod";

/**
 * The JSON body the app answers to TRANSACTION_CHARGE_REQUESTED or
 * TRANSACTION_CANCELATION_REQUESTED (sync success or failure), as Saleor reads it. Tests parse
 * `Response.json()` (typed `unknown`) with it, so a body of another shape fails the test.
 */
const transactionActionAnswerSchema = z
  .object({
    result: z.enum(["CHARGE_SUCCESS", "CHARGE_FAILURE", "CANCEL_SUCCESS", "CANCEL_FAILURE"]),
    pspReference: z.string(),
    amount: z.number().optional(),
    message: z.string().optional(),
    actions: z.array(z.enum(["CHARGE", "REFUND", "CANCEL"])).optional(),
    externalUrl: z.string().optional(),
    time: z.string().optional(),
  })
  .strict();

export type TransactionActionAnswer = z.infer<typeof transactionActionAnswerSchema>;

export const parseTransactionActionAnswer = (body: unknown): TransactionActionAnswer =>
  transactionActionAnswerSchema.parse(body);
