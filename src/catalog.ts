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

/** Shared buyer guarantee on every paid endpoint. */
export const NOT_CHARGED = "Not charged on bad input or stale data (every response carries as_of and stale_after).";

export const PAID_ENDPOINTS: PaidEndpoint[] = [
  {
    route: "signal",
    name: "Lumi coin signal (buy/sell read)",
    method: "GET",
    path: "/v1/signal/{coin}",
    template: "/v1/signal/{coin}",
    summary:
      "Use this when you need a fast, mechanical buy/sell read on one coin before acting: overall label + score, per-timeframe (1h/4h/1d) labels and an indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume). " + NOT_CHARGED,
    example: "/v1/signal/BTC",
  },
  {
    route: "levels",
    name: "Lumi support/resistance levels + 7-day projection",
    method: "GET",
    path: "/v1/levels/{coin}",
    template: "/v1/levels/{coin}",
    summary:
      "Use this when you need to know where price may stall or turn for one coin: support/resistance levels, bias, 7-day bull/base/bear projection, commentary, catalysts and cited sources. " + NOT_CHARGED,
    example: "/v1/levels/BTC",
  },
  {
    route: "slate",
    name: "Lumi paper-trade slate (current ideas)",
    method: "GET",
    path: "/v1/slate",
    template: "/v1/slate",
    summary:
      "Use this when you need current, concrete trade setups to evaluate (paper trades, not advice): direction, entry/entry zone, stop, targets, leverage, conviction, plus 'no setup' notes. " + NOT_CHARGED,
    example: "/v1/slate",
  },
  {
    route: "market",
    name: "Lumi BTC + macro market backdrop",
    method: "GET",
    path: "/v1/market",
    template: "/v1/market",
    summary:
      "Use this when you need the whole crypto backdrop in one call: BTC levels/projection/signal, macro (USD/JPY note, total cap, dominance, Fear & Greed, BTC perp funding/OI) and breadth across tracked coins. " + NOT_CHARGED,
    example: "/v1/market",
  },
  {
    route: "brief",
    name: "Lumi daily crypto market brief",
    method: "GET",
    path: "/v1/brief",
    template: "/v1/brief",
    summary:
      "Use this when you need a ready-to-read daily crypto brief (the same read as Lumi's newsletter): BTC price/levels/signal, Fear & Greed, funding, " +
      "top/bottom movers, key levels, yen watch, events in the next 48h, open paper trades and sourced news. JSON with a " +
      "ready-to-use `markdown` field; add ?format=md (or Accept: text/markdown) for text/markdown. " + NOT_CHARGED,
    example: "/v1/brief",
  },
  {
    route: "yen",
    name: "Lumi yen carry-trade watch (USD/JPY, Nikkei)",
    method: "GET",
    path: "/v1/macro/yen",
    template: "/v1/macro/yen",
    summary:
      "Use this when you need to check whether yen carry-trade stress could spill into crypto: USD/JPY and Nikkei 225 (price, 1d/5d change, ranges), " +
      "a rule-based carry-trade risk level (low/watch/elevated) around the 155 USD/JPY line with reasons, BTC context, upcoming Japan events (BOJ, CPI) and sources. " + NOT_CHARGED,
    example: "/v1/macro/yen",
  },
  {
    route: "sentiment",
    name: "Lumi crypto sentiment (Fear & Greed, funding)",
    method: "GET",
    path: "/v1/sentiment",
    template: "/v1/sentiment",
    summary:
      "Use this when you need a quick read of crowd positioning: Fear & Greed (value, band, day-over-day change), BTC perp funding rate with a plain-English " +
      "read + open interest, total market cap/volume/dominance, and breadth/signal-label counts across tracked coins. " + NOT_CHARGED,
    example: "/v1/sentiment",
  },
  {
    route: "events",
    name: "Lumi macro + crypto events calendar",
    method: "GET",
    path: "/v1/events",
    template: "/v1/events",
    summary:
      "Use this when you need to know what scheduled events could move crypto soon: timed releases/decisions (UTC + US Central, with why it matters) and dated " +
      "per-coin catalysts (Fed, BOJ, CPI, network upgrades, conferences). Every row is sourced. " + NOT_CHARGED,
    example: "/v1/events",
  },
  {
    route: "trades",
    name: "Lumi paper-trade history",
    method: "GET",
    path: "/v1/trades",
    template: "/v1/trades",
    summary:
      "Use this when you need the full list of Lumi's paper-trade ideas (not advice): every idea with entry, stop, targets, leverage and reasoning. " + NOT_CHARGED,
    example: "/v1/trades",
  },
  {
    route: "institutional",
    name: "Lumi Institutional & Policy Brief (daily, premium)",
    method: "GET",
    path: "/v1/institutional",
    template: "/v1/institutional",
    summary:
      "Use this when you need a sourced daily summary of what central banks, standard-setters, regulators, banks and tokenization firms are doing in " +
      "digital assets and stablecoins, and which tracked networks each move touches. Every item has a source URL, date, why-it-matters, impact and " +
      "confidence, and a link_type that separates confirmed links from indirect-alignment analysis. Also: big picture, per-coin map, cross-item " +
      "connections, no-news notes and dated what-to-watch. JSON with a `markdown` field; ?format=md returns text/markdown. Neutral and apolitical; " +
      "not financial advice. " + NOT_CHARGED,
    example: "/v1/institutional",
  },
  {
    route: "vendor_report",
    name: "Lumi x402 vendor report (full observation history)",
    method: "GET",
    path: "/v1/trust/vendors/{id}/report",
    template: "/v1/trust/vendors/{id}/report",
    summary:
      "Use this when you need evidence before paying an x402 vendor on Lumi's trust list: the full observation history. Every free 402-quote check (90-day retention) " +
      "with status, quoted price and latency; every paid test-buy with amount, ledger tx hash, explorer link and delivered yes/no; latency stats " +
      "(min/p50/p90/p95/max) and the 7-day trend; uptime % over 24h/7d/30d/90d and a daily series; per-endpoint quoted-price history; verified " +
      "agent reports; vendor replies; score components, sample sizes and confidence labels. Automated observations, not a rating. " +
      "Not sold (503, not charged) when the vendor has no observation in the last 48 h. The free summary is GET /v1/trust/vendors/{id}.",
    example: "/v1/trust/vendors/printmoneylab/report",
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
    price_base_usdc: cfg.evm?.prices[e.route] ?? null,
    prices: [
      ...(cfg.evm
        ? [{ asset: "USDC", amount: cfg.evm.prices[e.route], network: cfg.evm.network, chain: cfg.evm.networkName, token: cfg.evm.asset, amount_atomic: cfg.evm.amounts[e.route] }]
        : []),
      { asset: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]), network: cfg.network },
      ...cfg.ious.map((o) => ({ asset: o.symbol, amount: o.prices[e.route], currency: o.currency, issuer: o.issuer, network: cfg.network })),
    ],
    summary: e.summary,
    example: e.example,
  }));
}
