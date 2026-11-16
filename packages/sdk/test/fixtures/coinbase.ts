/**
 * Coinbase Exchange message fixtures, shaped after the official docs:
 * https://docs.cdp.coinbase.com/exchange/websocket-feed/channels
 */
let nextTradeId = 10;
/** Restarts trade numbering (call in beforeEach for predictable ids). */
export function resetTradeIds(start = 10): void {
  nextTradeId = start;
}

/**
 * A `match`. Without an explicit `trade_id`, ids increase by 1 per call, as
 * on the live feed, so consecutive fixtures are never mistaken for duplicates.
 */
export function match(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tradeId = "trade_id" in overrides ? overrides.trade_id : nextTradeId++;
  return {
    type: "match",
    trade_id: tradeId,
    sequence: 50,
    maker_order_id: "ac928c66-ca53-498f-9c13-a110027a60e8",
    taker_order_id: "132fb6ae-456b-4654-b4e0-d681ac05cea1",
    time: "2014-11-07T08:19:27.028459Z",
    product_id: "BTC-USD",
    size: "5.23512",
    price: "400.23",
    side: "sell",
    ...overrides,
  };
}

export function subscriptions(productIds: string[]): Record<string, unknown> {
  return {
    type: "subscriptions",
    channels: [
      { name: "matches", product_ids: productIds },
      { name: "heartbeat", product_ids: productIds },
    ],
  };
}

export const heartbeat = {
  type: "heartbeat",
  sequence: 90,
  last_trade_id: 20,
  product_id: "BTC-USD",
  time: "2014-11-07T08:19:28.464459Z",
};

export function error(message: string, reason?: string): Record<string, unknown> {
  return { type: "error", message, ...(reason && { reason }) };
}

/** Sent by Coinbase for each newly subscribed product: the latest trade, before ours. */
export function lastMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...match(overrides), type: "last_match" };
}
