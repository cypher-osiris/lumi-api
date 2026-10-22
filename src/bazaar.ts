/**
 * x402 Bazaar discovery metadata (the `bazaar` extension of a v2 PaymentRequired), one entry per paid route.
 *
 * The CDP facilitator indexes a resource after its first successful settlement, using `paymentPayload.resource`
 * (url, description <= 500 chars, mimeType) and `paymentPayload.extensions.bazaar` (`info` validated against
 * `schema` with JSON Schema 2020-12). The shape matches `declareDiscoveryExtension()` from @x402/extensions, with
 * `routeTemplate` + `pathParams` for the parameterised routes so all coins / vendors collapse into one listing.
 * Examples are deliberately short: the whole PaymentRequired also travels base64-encoded in a response header.
 */

import type { PaidRoute } from "./config";

/** CDP rejects verify/settle when resource.description is longer than this. */
export const BAZAAR_MAX_DESCRIPTION = 500;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface RouteMeta {
  /** Listing text (<= 500 chars, plain description). */
  description: string;
  /** Colon-style template for routes with a path parameter. */
  routeTemplate?: string;
  pathParam?: { name: string; schema: Record<string, Json> };
  /** Optional query parameters (all optional). */
  query?: Record<string, Record<string, Json>>;
  example: Record<string, Json>;
}

const COIN_PARAM = {
  name: "coin",
  schema: { type: "string", pattern: "^[A-Za-z0-9]{1,15}$", description: "Coin symbol, e.g. XRP, BTC, ETH, HBAR (list: GET /v1/coins, free)" },
};
const FORMAT_QUERY = {
  format: { type: "string", enum: ["json", "md"], description: "md returns the brief as text/markdown; default JSON (with a markdown field)" },
};

const PAYMENT_EXAMPLE: Record<string, Json> = {
  network: "eip155:8453",
  asset: "USDC",
  amount: "0.01",
  transaction: "0x5f0c...e41a",
  payer: "0x12ab...89cd",
};

export const BAZAAR_ROUTES: Record<PaidRoute, RouteMeta> = {
  signal: {
    description:
      "Mechanical buy/sell signal for one crypto coin (BTC, ETH, XRP, SOL, HBAR and more): overall label and score, per-timeframe " +
      "(1h/4h/1d) labels and an indicator breakdown (RSI, MACD, EMA stack, Bollinger, StochRSI, volume) with price context. JSON.",
    routeTemplate: "/v1/signal/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "signal",
      coin: { symbol: "XRP", name: "XRP" },
      label: "Sell",
      score: -0.34,
      price: { usd: 1.33, change_24h_pct: -2.19 },
      timeframes: { "1h": { label: "Sell", score: -0.3 }, "4h": { label: "Neutral", score: 0 }, "1d": { label: "Strong Sell", score: -0.7 } },
      generated_utc: "2026-10-22T11:17:26Z",
      payment: PAYMENT_EXAMPLE,
    },
  },
  levels: {
    description:
      "Support and resistance levels for one crypto coin with bias, a 7-day bull/base/bear price projection, analyst commentary, " +
      "upcoming catalysts and cited sources. JSON.",
    routeTemplate: "/v1/levels/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "levels",
      coin: { symbol: "XRP", name: "XRP" },
      price: { usd: 1.33 },
      bias: "neutral-to-soft",
      support: [1.323, 1.3],
      resistance: [1.369, 1.4],
      projection: { horizon_days: 7, bull: 1.4, base: 1.33, bear: 1.27 },
      commentary: "Holding the 1.32-1.33 pivot; a close above 1.37 flips the read.",
      catalysts: [{ date: "2026-10-28", title: "FOMC decision" }],
      sources: [{ title: "CoinGecko", url: "https://www.coingecko.com/en/coins/ripple" }],
      payment: PAYMENT_EXAMPLE,
    },
  },
  slate: {
    description:
      "Current crypto paper-trade ideas: direction, entry zone, stop, targets, leverage, conviction and status for each idea, " +
      "plus no-setup notes. JSON.",
    example: {
      kind: "slate",
      as_of: "2026-10-22T11:05:00Z",
      ideas: [{ coin: "BTC", direction: "long", entry_zone: { low: 81800, high: 82300 }, stop: 80800, targets: [84500, 86000], leverage: 3, conviction: "medium", status: "open" }],
      payment: PAYMENT_EXAMPLE,
    },
  },
  market: {
    description:
      "Crypto market backdrop: BTC levels, projection and signal; macro context (USD/JPY yen note, total market cap, BTC/ETH dominance, " +
      "Fear & Greed, BTC perpetual funding and open interest) and up/down breadth across 13 tracked coins. JSON.",
    example: {
      kind: "market",
      btc_backdrop: { bias: "soft", support: [80000, 81000], resistance: [82500, 84800] },
      macro: { total_mcap_usd: 2742576601668, btc_dominance_pct: 60.04, fear_greed: { value: 49, classification: "Neutral" } },
      breadth: { coins_tracked: 13, up_24h: 1, down_24h: 12 },
      analysis_as_of: "2026-10-22T11:05:00Z",
      payment: PAYMENT_EXAMPLE,
    },
  },
  brief: {
    description:
      "Daily crypto market brief: BTC price, levels and signal, Fear & Greed, funding, top/bottom movers, key levels for 13 coins, " +
      "yen watch, macro events in the next 48h, paper trades and sourced news. JSON with a ready-to-use markdown field; " +
      "format=md returns text/markdown.",
    query: FORMAT_QUERY,
    example: {
      kind: "brief",
      date: "2026-10-22",
      headline: "Crypto slides with stocks",
      bitcoin: { usd: 81984, change_24h_pct: -1.62, signal: "Sell" },
      key_levels: [{ coin: "ETH", support: 3800, resistance: 4100 }],
      events_next_48h: [{ at_utc: "2026-10-22T23:30:00Z", title: "Japan September CPI" }],
      markdown: "# Lumi daily brief, Oct 22 2026 ...",
      payment: PAYMENT_EXAMPLE,
    },
  },
  yen: {
    description:
      "Yen carry-trade watch for crypto traders: USD/JPY and Nikkei 225 (price, 1d/5d change, ranges), a rule-based carry-trade risk " +
      "level (low/watch/elevated) around the 155 USD/JPY line with reasons, BTC context and upcoming Japan events (BOJ, CPI). JSON.",
    example: {
      kind: "macro_yen",
      usd_jpy: { price: 157.08, change_pct: -0.62, change_5d_pct: -0.67 },
      nikkei_225: { price: 62907.84, change_pct: -2.65 },
      carry_trade_risk: { level: "watch", key_level: 155, distance_to_key_level_pct: 1.34, reasons: ["USD/JPY within 1.5% of 155"] },
      japan_events: [{ date: "2026-10-30", title: "BOJ policy decision" }],
      payment: PAYMENT_EXAMPLE,
    },
  },
  sentiment: {
    description:
      "Crypto sentiment snapshot: CoinMarketCap Fear & Greed (value, band, day-over-day change), BTC perpetual funding rate with a " +
      "plain-English read and open interest, total market cap, volume and dominance, and breadth / signal-label counts across 13 coins. JSON.",
    example: {
      kind: "sentiment",
      fear_greed: { value: 49, classification: "Neutral", previous: 54, change: -5 },
      derivatives: { instrument: "BTC-USDT-SWAP (OKX)", funding_rate_pct: 0.00657, open_interest_usd: 2462680121 },
      global: { total_mcap_usd: 2742576601668, btc_dominance_pct: 60.04 },
      breadth: { coins_tracked: 13, up_24h: 1, down_24h: 12 },
      payment: PAYMENT_EXAMPLE,
    },
  },
  events: {
    description:
      "Calendar of upcoming macro and crypto events that can move prices: timed releases and central-bank decisions (UTC and US Central, " +
      "with why each matters) and dated per-coin catalysts such as network upgrades. Every row is sourced. JSON.",
    example: {
      kind: "events",
      next: { at_utc: "2026-10-22T23:30:00Z", title: "Japan September CPI", why: "Last national CPI before the BOJ meeting." },
      upcoming_timed: [{ at_utc: "2026-10-28T18:00:00Z", title: "FOMC rate decision", url: "https://www.federalreserve.gov/" }],
      upcoming_by_date: [{ date: "2026-11-03", coin: "XLM", title: "Protocol 30 validator vote" }],
      payment: PAYMENT_EXAMPLE,
    },
  },
  trades: {
    description:
      "Crypto paper-trade history as a raw list: entry, stop, targets, leverage, status and reasoning for every idea. JSON.",
    example: {
      kind: "trades",
      count: 8,
      trades: [{ id: "T007", coin: "BTC", direction: "long", entry: 82300, stop: 80800, targets: [84500, 86000], leverage: 3, status: "open" }],
      payment: PAYMENT_EXAMPLE,
    },
  },
  institutional: {
    description:
      "Daily sourced institutional and policy brief: what central banks, standard-setters, regulators, banks and tokenization firms " +
      "(BIS, IMF, US Treasury/OCC, Fed, SEC, CFTC and others) are doing and how each move maps to XRP, XLM, XDC, QNT, AXL and HBAR " +
      "(plus RLUSD/USDC). Each item has source URL, date, impact, confidence and a link type separating confirmed links from " +
      "indirect alignment. JSON with a markdown field; format=md returns text/markdown.",
    query: FORMAT_QUERY,
    example: {
      kind: "institutional_brief",
      date: "2026-10-22",
      big_picture: ["US stablecoin rules move from law to implementation."],
      items: [
        {
          entity: "US Treasury / OCC",
          headline: "OCC issues final GENIUS Act rule for payment stablecoin issuers",
          date: "2026-10-21",
          source_url: "https://occ.gov/news-issuances/news-releases/2026/nr-occ-2026-92.html",
          coins: ["RLUSD", "USDC"],
          link_type: "context",
          impact: "bullish",
          confidence: "high",
        },
      ],
      watch_next: [{ date: "2026-10-29", what: "BOJ policy meeting" }],
      markdown: "# Institutional & Policy Brief, Oct 22 2026 ...",
      payment: { ...PAYMENT_EXAMPLE, amount: "0.25" },
    },
  },
  vendor_report: {
    description:
      "Detailed observation report for one x402 API vendor on Lumi's trust list: every free 402-quote check (90-day retention) with " +
      "status, price and latency; paid test-buys with tx hashes and delivered yes/no; latency percentiles; uptime over 24h/7d/30d/90d; " +
      "quoted-price history; verified agent reports and score components. Automated observations, not a rating. JSON.",
    routeTemplate: "/v1/trust/vendors/:id/report",
    pathParam: {
      name: "id",
      schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Vendor id from GET /v1/trust/vendors (free)" },
    },
    example: {
      kind: "trust_vendor_report",
      id: "example-vendor",
      name: "Example Vendor",
      score: { value: 82, confidence: "medium", window_days: 30 },
      windows: { "24h": { uptime_pct: 100 }, "7d": { uptime_pct: 99.4 } },
      paid_test_buys: { count: 6, delivered: 6, delivery_pct: 100 },
      quote_checks: { columns: ["checked_at", "endpoint", "http_status", "valid_quote", "price"], rows: [["2026-10-22T12:30:00Z", 0, 402, true, "0.01"]] },
      payment: { ...PAYMENT_EXAMPLE, amount: "0.02" },
    },
  },
};

/** Minimal JSON Schema for an example value: type at every level, object properties to depth 2, all present keys required at the top. */
export function schemaFor(v: Json, depth = 0): Record<string, Json> {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return { type: "array" };
  if (typeof v === "object") {
    if (depth >= 1) return { type: "object" };
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaFor(x, depth + 1)])),
      required: Object.keys(v).filter((k) => k === "kind" || k === "payment"),
    };
  }
  return { type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string" };
}

/**
 * The `bazaar` extension for one request. `arg` is the concrete path parameter (coin symbol / vendor id) of this URL,
 * `query` the recognised query parameters actually present.
 */
export function bazaarExtension(route: PaidRoute, arg?: string, query?: Record<string, string>): Record<string, Json> {
  const meta = BAZAAR_ROUTES[route];
  const input: Record<string, Json> = { type: "http", method: "GET" };
  const inputProps: Record<string, Json> = {
    type: { type: "string", const: "http" },
    method: { type: "string", enum: ["GET"] },
  };
  if (meta.query) {
    const present = Object.fromEntries(Object.entries(query ?? {}).filter(([k]) => k in meta.query!));
    if (Object.keys(present).length) input.queryParams = present;
    inputProps.queryParams = { type: "object", properties: meta.query, additionalProperties: false };
  }
  if (meta.pathParam && arg !== undefined) {
    input.pathParams = { [meta.pathParam.name]: arg };
    inputProps.pathParams = {
      type: "object",
      properties: { [meta.pathParam.name]: meta.pathParam.schema },
      required: [meta.pathParam.name],
      additionalProperties: false,
    };
  }
  return {
    info: { input, output: { type: "json", example: meta.example } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: inputProps, required: ["type", "method"], additionalProperties: false },
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: schemaFor(meta.example) },
          required: ["type"],
        },
      },
      required: ["input"],
    },
    ...(meta.routeTemplate && arg !== undefined ? { routeTemplate: meta.routeTemplate } : {}),
  };
}

/** resource.description for a quote: the full summary when it fits CDP's limit, otherwise the Bazaar listing text. */
export function resourceDescription(route: PaidRoute, full: string): string {
  if (full.length <= BAZAAR_MAX_DESCRIPTION) return full;
  return BAZAAR_ROUTES[route].description.slice(0, BAZAAR_MAX_DESCRIPTION);
}
