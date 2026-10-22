/** Single source of truth for endpoints, prices and descriptions (used by docs, discovery and the paywall). */

import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";

export interface PaidEndpoint {
  route: PaidRoute;
  method: "GET";
  path: string;
  /** Short listing name (XRPL AI Hub / x402 indexes ingest it). */
  name: string;
  /** OpenAPI-style template. */
  template: string;
  summary: string;
  example: string;
}

export const PAID_ENDPOINTS: PaidEndpoint[] = [
  {
    route: "signal",
    name: "Lumi coin signal (buy/sell read)",
    method: "GET",
    path: "/v1/signal/{coin}",
    template: "/v1/signal/{coin}",
    summary:
      "Mechanical buy/sell read for one coin: overall label + score, per-timeframe (1h/4h/1d) labels and an indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume).",
    example: "/v1/signal/XRP",
  },
  {
    route: "levels",
    name: "Lumi support/resistance levels + 7-day projection",
    method: "GET",
    path: "/v1/levels/{coin}",
    template: "/v1/levels/{coin}",
    summary:
      "Lumi's support/resistance levels, bias, 7-day bull/base/bear projection, commentary, catalysts and cited sources for one coin.",
    example: "/v1/levels/XRP",
  },
  {
    route: "slate",
    name: "Lumi paper-trade slate (current ideas)",
    method: "GET",
    path: "/v1/slate",
    template: "/v1/slate",
    summary:
      "Current paper-trade ideas: direction, entry/entry zone, stop, targets, leverage, conviction, status, plus 'no setup' notes and the public track record.",
    example: "/v1/slate",
  },
  {
    route: "market",
    name: "Lumi BTC + macro market backdrop",
    method: "GET",
    path: "/v1/market",
    template: "/v1/market",
    summary:
      "Market backdrop: BTC levels/projection/signal, macro (yen/USDJPY note, total cap, dominance, fear & greed, BTC perp funding/OI) and breadth across Lumi's 13 coins.",
    example: "/v1/market",
  },
  {
    route: "brief",
    name: "Lumi daily crypto market brief",
    method: "GET",
    path: "/v1/brief",
    template: "/v1/brief",
    summary:
      "Today's market brief, the same read as Lumi's newsletter and Shorts: BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, " +
      "top/bottom movers, key levels for 13 coins, yen watch, events in the next 48h, paper trades + record, sourced news. JSON with a " +
      "ready-to-use `markdown` field; add ?format=md (or Accept: text/markdown) for text/markdown.",
    example: "/v1/brief",
  },
  {
    route: "yen",
    name: "Lumi yen carry-trade watch (USD/JPY, Nikkei)",
    method: "GET",
    path: "/v1/macro/yen",
    template: "/v1/macro/yen",
    summary:
      "Yen carry-trade watch: USD/JPY and Nikkei 225 (price, 1d/5d change, ranges), a rule-based carry-trade risk level (low/watch/elevated) " +
      "around the 155 USD/JPY line with reasons, Lumi's yen note, BTC context, upcoming Japan events (BOJ, CPI) and sources.",
    example: "/v1/macro/yen",
  },
  {
    route: "sentiment",
    name: "Lumi crypto sentiment (Fear & Greed, funding)",
    method: "GET",
    path: "/v1/sentiment",
    template: "/v1/sentiment",
    summary:
      "Crypto sentiment snapshot: CoinMarketCap Fear & Greed (value, band, day-over-day change), BTC perp funding rate with a plain-English " +
      "read + open interest (OKX), total market cap/volume/dominance, and breadth/signal-label counts across Lumi's 13 coins.",
    example: "/v1/sentiment",
  },
  {
    route: "events",
    name: "Lumi macro + crypto events calendar",
    method: "GET",
    path: "/v1/events",
    template: "/v1/events",
    summary:
      "Upcoming macro and crypto events that can move prices: timed releases/decisions (UTC + US Central, with why it matters) and dated " +
      "per-coin catalysts (Fed, BOJ, CPI, network upgrades, conferences). Every row is sourced.",
    example: "/v1/events",
  },
  {
    route: "trades",
    name: "Lumi paper-trade history + track record",
    method: "GET",
    path: "/v1/trades",
    template: "/v1/trades",
    summary:
      "Lumi's full paper-trade history (every idea: entry, stop, targets, leverage, outcome, reasoning) and an honest computed track record: " +
      "win rate, sum/avg P&L, best/worst, by coin, by direction, equity curve, open unrealized P&L.",
    example: "/v1/trades",
  },
];

export function priceTable(cfg: Config) {
  return PAID_ENDPOINTS.map((e) => ({
    method: e.method,
    path: e.path,
    name: e.name,
    price_xrp: dropsToXrp(cfg.pricesDrops[e.route]),
    price_drops: cfg.pricesDrops[e.route],
    price_rlusd: cfg.ious.find((o) => o.symbol === "RLUSD")?.prices[e.route] ?? null,
    price_usdc: cfg.ious.find((o) => o.symbol === "USDC")?.prices[e.route] ?? null,
    prices: [
      { asset: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]) },
      ...cfg.ious.map((o) => ({ asset: o.symbol, amount: o.prices[e.route], currency: o.currency, issuer: o.issuer })),
    ],
    summary: e.summary,
    example: e.example,
  }));
}
