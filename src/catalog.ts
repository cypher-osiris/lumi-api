/** Single source of truth for endpoints, prices and descriptions (used by docs, discovery and the paywall). */

import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";

export interface PaidEndpoint {
  route: PaidRoute;
  method: "GET";
  path: string;
  /** OpenAPI-style template. */
  template: string;
  summary: string;
  example: string;
}

export const PAID_ENDPOINTS: PaidEndpoint[] = [
  {
    route: "signal",
    method: "GET",
    path: "/v1/signal/{coin}",
    template: "/v1/signal/{coin}",
    summary:
      "Mechanical buy/sell read for one coin: overall label + score, per-timeframe (1h/4h/1d) labels and an indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume).",
    example: "/v1/signal/XRP",
  },
  {
    route: "levels",
    method: "GET",
    path: "/v1/levels/{coin}",
    template: "/v1/levels/{coin}",
    summary:
      "Lumi's support/resistance levels, bias, 7-day bull/base/bear projection, commentary, catalysts and cited sources for one coin.",
    example: "/v1/levels/XRP",
  },
  {
    route: "slate",
    method: "GET",
    path: "/v1/slate",
    template: "/v1/slate",
    summary:
      "Current paper-trade ideas: direction, entry/entry zone, stop, targets, leverage, conviction, status, plus 'no setup' notes and the public track record.",
    example: "/v1/slate",
  },
  {
    route: "market",
    method: "GET",
    path: "/v1/market",
    template: "/v1/market",
    summary:
      "Market backdrop: BTC levels/projection/signal, macro (yen/USDJPY note, total cap, dominance, fear & greed, BTC perp funding/OI) and breadth across Lumi's 13 coins.",
    example: "/v1/market",
  },
];

export function priceTable(cfg: Config) {
  return PAID_ENDPOINTS.map((e) => ({
    method: e.method,
    path: e.path,
    price_xrp: dropsToXrp(cfg.pricesDrops[e.route]),
    price_drops: cfg.pricesDrops[e.route],
    summary: e.summary,
    example: e.example,
  }));
}
