import { config } from "./config";
import { getPool } from "./db/client";
import { markQuotePaymentActivated, markQuotePaymentFailed } from "./db/paymentIntentRepository";
import { acceptQuote } from "./db/ticketRepository";

function isTerminalPaymentActivationError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message === "quote_expired" || message.startsWith("quote_not_acceptable") || message.startsWith("quote_requires_review");
}

export async function activateConfirmedQuotePayment(input: { quoteId: string; userId: string }) {
  let ticket;
  try {
    ticket = await acceptQuote(input.quoteId, input.userId, {
      accountingMode: "house_book_usdc",
      currency: "USDC",
      maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
      maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
      maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
    });
  } catch (error) {
    if (isTerminalPaymentActivationError(error)) {
      await markQuotePaymentFailed({
        quoteId: input.quoteId,
        userId: input.userId,
        reason: error instanceof Error ? error.message : "activation_failed"
      });
    }
    throw error;
  }

  await markQuotePaymentActivated({
    quoteId: input.quoteId,
    userId: input.userId,
    ticketId: ticket.ticketId
  });

  return ticket;
}

export async function activateConfirmedQuotePayments(limit = 25) {
  const result = await getPool().query<{
    quoteId: string;
    userId: string;
  }>(
    `
      SELECT quote_id AS "quoteId", user_id AS "userId"
      FROM quote_payment_intents
      WHERE status = 'confirmed'
      ORDER BY confirmed_at ASC NULLS LAST, updated_at ASC
      LIMIT $1
    `,
    [limit]
  );

  let activated = 0;
  const failed: Array<{ quoteId: string; userId: string; error: string }> = [];

  for (const intent of result.rows) {
    try {
      await activateConfirmedQuotePayment(intent);
      activated += 1;
    } catch (error) {
      failed.push({
        ...intent,
        error: error instanceof Error ? error.message : "activation_failed"
      });
    }
  }

  return {
    scanned: result.rows.length,
    activated,
    failed
  };
}
