import { isObject, isStringArray, toEpochMs, toFiniteNumber } from "../validate.js";
import type { AdapterEvent, ExchangeAdapter } from "./types.js";

/**
 * Coinbase Exchange public market data feed.
 *
 * Docs: https://docs.cdp.coinbase.com/exchange/websocket-feed/overview
 *
 * - `matches` carries every trade; no authentication needed.
 * - `heartbeat` sends a message per product every second, which keeps our
 *   stale-connection detector honest on quiet markets.
 * - There is no candle channel, so candles are derived from trades.
 * - Coinbase disconnects clients that don't subscribe within 5s of connecting,
 *   which is why the client only connects on the first `subscribe()`.
 */
const CHANNELS = ["matches", "heartbeat"] as const;

function request(type: "subscribe" | "unsubscribe", symbols: readonly string[]): string {
  return JSON.stringify({ type, product_ids: symbols, channels: CHANNELS });
}

function parseMatch(msg: Record<string, unknown>): AdapterEvent {
  const symbol = msg.product_id;
  const price = toFiniteNumber(msg.price);
  const size = toFiniteNumber(msg.size);
  const timestamp = toEpochMs(msg.time);
  const makerSide = msg.side;
  const tradeId = msg.trade_id;

  if (typeof symbol !== "string" || symbol === "") return invalid("match: missing product_id");
  if (price === undefined || price <= 0) return invalid("match: invalid price");
  if (size === undefined || size < 0) return invalid("match: invalid size");
  if (timestamp === undefined) return invalid("match: invalid time");
  if (makerSide !== "buy" && makerSide !== "sell") return invalid("match: invalid side");
  if (typeof tradeId !== "number" && typeof tradeId !== "string") {
    return invalid("match: missing trade_id");
  }

  return {
    type: "trade",
    trade: {
      exchange: "coinbase",
      symbol,
      id: String(tradeId),
      price,
      size,
      // Coinbase's `side` is the MAKER's side. The aggressor (taker) is the
      // opposite, and the taker side is what "buy/sell trade" conventionally means.
      side: makerSide === "buy" ? "sell" : "buy",
      timestamp,
    },
  };
}

/**
 * Coinbase answers every subscribe/unsubscribe with exactly one
 * `subscriptions` message holding the FULL current subscription list. It
 * carries no request id, and for invalid products it is preceded by one
 * `error` per channel (observed live; not in the docs). We report the
 * `matches` product list so the client can judge success per symbol.
 */
function parseSubscriptions(msg: Record<string, unknown>): AdapterEvent {
  if (!Array.isArray(msg.channels)) return invalid("subscriptions: no channels");
  const matches: unknown = msg.channels.find((c) => isObject(c) && c.name === "matches");
  if (matches === undefined) return { type: "ack", subscribed: [] };
  if (!isObject(matches) || !isStringArray(matches.product_ids)) {
    return invalid("subscriptions: invalid product_ids");
  }
  return { type: "ack", subscribed: matches.product_ids };
}

function invalid(reason: string): AdapterEvent {
  return { type: "invalid", reason };
}

export const coinbase: ExchangeAdapter = {
  id: "coinbase",
  defaultUrl: "wss://ws-feed.exchange.coinbase.com",

  subscribeMessage: (symbols) => request("subscribe", symbols),
  unsubscribeMessage: (symbols) => request("unsubscribe", symbols),

  parse(raw) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return invalid("not valid JSON");
    }
    if (!isObject(msg) || typeof msg.type !== "string") return invalid("missing message type");

    switch (msg.type) {
      case "match":
        return parseMatch(msg);
      case "subscriptions":
        return parseSubscriptions(msg);
      case "error": {
        const message = typeof msg.message === "string" ? msg.message : "Unknown exchange error";
        const reason = typeof msg.reason === "string" ? `: ${msg.reason}` : "";
        return { type: "exchange-error", message: message + reason };
      }
      case "last_match":
        // A replay of the last trade before we subscribed. Re-sent on every
        // reconnect, so emitting it would duplicate trades and skew candles.
        return { type: "ignored" };
      default:
        // heartbeat, and any message type Coinbase adds in the future.
        // Unknown types are not errors: that keeps old SDK versions working.
        return { type: "ignored" };
    }
  },
};
