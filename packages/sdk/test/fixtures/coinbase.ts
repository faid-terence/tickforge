/**
 * Coinbase Exchange message fixtures, shaped after the official docs:
 * https://docs.cdp.coinbase.com/exchange/websocket-feed/channels
 */
export function match(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "match",
    trade_id: 10,
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
