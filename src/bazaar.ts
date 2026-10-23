/**
 * x402 Bazaar discovery metadata (the `bazaar` extension of a v2 PaymentRequired), one entry per paid route.
 *
 * The CDP facilitator indexes a resource after its first successful settlement, using `paymentPayload.resource`
 * (url, description <= 500 chars, mimeType) and `paymentPayload.extensions.bazaar` (`info` validated against
 * `schema` with JSON Schema 2020-12). The shape matches `declareDiscoveryExtension()` from @x402/extensions, with
 * `routeTemplate` + `pathParams` for the parameterised routes so all coins / vendors collapse into one listing.
 * Examples are deliberately short: the whole PaymentRequired also travels base64-encoded in a response header.
 */

import { DEFAULT_PRICES, type PaidRoute } from "./config";

/** CDP rejects verify/settle when resource.description is longer than this. */
export const BAZAAR_MAX_DESCRIPTION = 500;

/**
 * Bazaar service metadata (x402 v2 `resource.serviceName/tags/iconUrl`): printable ASCII, serviceName <= 32 chars,
 * at most 5 tags of <= 32 chars each. Each route gets its own tag set so the listings cover many search terms.
 */
export const SERVICE_NAME = "Lumi Trades";
export const SERVICE_ICON = "https://lumitrades.io/assets/icon-512.png";
export const ROUTE_TAGS: Record<PaidRoute, string[]> = {
  signal: ["crypto-signals", "trading-signals", "technical-analysis", "bitcoin", "ethereum"],
  levels: ["support-resistance", "technical-analysis", "price-levels", "bitcoin", "crypto"],
  slate: ["trade-ideas", "paper-trading", "crypto-trading", "bitcoin", "crypto"],
  market: ["market-data", "bitcoin", "funding-rates", "open-interest", "crypto"],
  brief: ["market-brief", "crypto-news", "daily-report", "bitcoin", "crypto"],
  yen: ["macro", "forex", "yen-carry-trade", "japan", "bitcoin"],
  sentiment: ["sentiment", "fear-and-greed", "funding-rates", "open-interest", "crypto"],
  events: ["economic-calendar", "events", "macro", "bitcoin", "crypto"],
  trades: ["paper-trading", "trade-history", "trade-ideas", "trading", "crypto"],
  institutional: ["regulation", "stablecoins", "tokenization", "policy", "crypto"],
  vendor_report: ["x402", "trust-score", "api-monitoring", "security", "due-diligence"],
  scan: ["crypto-screener", "trading-signals", "market-scan", "technical-analysis", "crypto"],
  lite: ["crypto-signals", "trading-signals", "bitcoin", "cheap", "crypto"],
  trust_check: ["x402", "payment-safety", "trust-score", "fraud-check", "agent-payments"],
  funding: ["funding-rates", "perpetuals", "derivatives", "positioning", "crypto"],
  fear_greed: ["fear-and-greed", "sentiment", "coinmarketcap", "bitcoin", "crypto"],
  events_48h: ["economic-calendar", "events", "macro", "fomc", "crypto"],
};

export function serviceMeta(route: PaidRoute): { serviceName: string; tags: string[]; iconUrl: string } {
  return { serviceName: SERVICE_NAME, tags: ROUTE_TAGS[route], iconUrl: SERVICE_ICON };
}

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

/** Example `payment` block of a paid response, at the route's real (default) Base USDC price. */
const pay = (route: PaidRoute, usd: string = DEFAULT_PRICES[route].usd): Record<string, Json> => ({
  network: "eip155:8453",
  asset: "USDC",
  amount: usd,
  transaction: "0x5f0c...e41a",
  payer: "0x12ab...89cd",
});

/** Example freshness fields (present on every paid response). */
const FRESH = (asOf: string, staleAfter: string): Record<string, Json> => ({ as_of: asOf, stale_after: staleAfter });

/** Shared promise appended to every listing. */
export const FAIR_USE =
  "Every response carries as_of, data_age_seconds, next_update and stale_after. Not charged on bad input or stale data.";

export const BAZAAR_ROUTES: Record<PaidRoute, RouteMeta> = {
  signal: {
    description:
      "Use this when you need a fast, mechanical buy/sell read on one crypto coin before acting: overall label and score, " +
      "1h/4h/1d labels and the indicator breakdown (RSI, MACD, EMA stack, Bollinger, StochRSI, volume) with price context. " +
      "50 top coins (BTC, ETH, SOL... see GET /v1/coins), computed live; 1h refreshed about every 13 minutes. " + FAIR_USE + " JSON.",
    routeTemplate: "/v1/signal/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "signal",
      coin: { symbol: "BTC", name: "Bitcoin" },
      label: "Sell",
      score: -0.34,
      price: { usd: 81984, change_24h_pct: -1.62 },
      timeframes: { "1h": { label: "Sell", score: -0.3 }, "4h": { label: "Neutral", score: 0 }, "1d": { label: "Strong Sell", score: -0.7 } },
      ...FRESH("2026-10-22T11:17:26Z", "2026-10-22T23:17:26Z"),
      payment: pay("signal"),
    },
  },
  levels: {
    description:
      "Use this when you need to know where price may stall or turn for one crypto coin: support and resistance levels, bias, " +
      "a 7-day bull/base/bear projection, analyst commentary, upcoming catalysts and cited sources. " + FAIR_USE + " JSON.",
    routeTemplate: "/v1/levels/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "levels",
      coin: { symbol: "ETH", name: "Ethereum" },
      price: { usd: 3920 },
      bias: "neutral-to-soft",
      support: [3850, 3780],
      resistance: [4010, 4100],
      projection: { horizon_days: 7, bull: 4100, base: 3930, bear: 3760 },
      commentary: "Holding the 3.85k pivot; a close above 4.01k flips the read.",
      catalysts: [{ date: "2026-10-28", title: "FOMC decision" }],
      sources: [{ title: "CoinGecko", url: "https://www.coingecko.com/en/coins/ethereum" }],
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-23T11:05:00Z"),
      payment: pay("levels"),
    },
  },
  slate: {
    description:
      "Use this when you need current, concrete crypto trade setups to evaluate (paper trades, not advice): direction, entry " +
      "zone, stop, targets, leverage and conviction for each idea, plus no-setup notes. " + FAIR_USE + " JSON.",
    example: {
      kind: "slate",
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      ideas: [{ coin: "BTC", direction: "long", entry_zone: { low: 81800, high: 82300 }, stop: 80800, targets: [84500, 86000], leverage: 3, conviction: "medium" }],
      payment: pay("slate"),
    },
  },
  market: {
    description:
      "Use this when you need the overall crypto market backdrop in one call: BTC levels, projection and signal; total market cap, " +
      "BTC/ETH dominance, Fear & Greed, BTC perpetual funding and open interest, a USD/JPY note and up/down breadth across " +
      "tracked coins. " + FAIR_USE + " JSON.",
    example: {
      kind: "market",
      btc_backdrop: { bias: "soft", support: [80000, 81000], resistance: [82500, 84800] },
      macro: { total_mcap_usd: 2742576601668, btc_dominance_pct: 60.04, fear_greed: { value: 49, classification: "Neutral" } },
      breadth: { coins_tracked: 13, up_24h: 1, down_24h: 12 },
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      payment: pay("market"),
    },
  },
  brief: {
    description:
      "Use this when you need a ready-to-read daily crypto market brief: BTC price, levels and signal, Fear & Greed, funding, " +
      "top/bottom movers, key levels, macro events in the next 48h, open paper trades and sourced news. JSON with a markdown " +
      "field; format=md returns text/markdown. " + FAIR_USE,
    query: FORMAT_QUERY,
    example: {
      kind: "brief",
      date: "2026-10-22",
      headline: "Crypto slides with stocks",
      bitcoin: { usd: 81984, change_24h_pct: -1.62, signal: "Sell" },
      key_levels: [{ coin: "ETH", support: 3800, resistance: 4100 }],
      events_next_48h: [{ at_utc: "2026-10-22T23:30:00Z", title: "Japan September CPI" }],
      markdown: "# Lumi daily brief, Oct 22 2026 ...",
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-24T11:05:00Z"),
      payment: pay("brief"),
    },
  },
  yen: {
    description:
      "Use this when you need to check whether yen carry-trade stress could hit crypto: USD/JPY and Nikkei 225 (price, 1d/5d " +
      "change, ranges), a rule-based carry-trade risk level (low/watch/elevated) around 155 USD/JPY with reasons, BTC context " +
      "and upcoming Japan events (BOJ, CPI). " + FAIR_USE + " JSON.",
    example: {
      kind: "macro_yen",
      usd_jpy: { price: 157.08, change_pct: -0.62, change_5d_pct: -0.67 },
      nikkei_225: { price: 62907.84, change_pct: -2.65 },
      carry_trade_risk: { level: "watch", key_level: 155, distance_to_key_level_pct: 1.34, reasons: ["USD/JPY within 1.5% of 155"] },
      japan_events: [{ date: "2026-10-30", title: "BOJ policy decision" }],
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      payment: pay("yen"),
    },
  },
  sentiment: {
    description:
      "Use this when you need a quick read of crypto crowd positioning: Fear & Greed (value, band, day-over-day change), BTC " +
      "perpetual funding with a plain-English read and open interest, total market cap, volume, dominance and breadth / " +
      "signal-label counts. " + FAIR_USE + " JSON.",
    example: {
      kind: "sentiment",
      fear_greed: { value: 49, classification: "Neutral", previous: 54, change: -5 },
      derivatives: { instrument: "BTC-USDT-SWAP (OKX)", funding_rate_pct: 0.00657, open_interest_usd: 2462680121 },
      global: { total_mcap_usd: 2742576601668, btc_dominance_pct: 60.04 },
      breadth: { coins_tracked: 13, up_24h: 1, down_24h: 12 },
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      payment: pay("sentiment"),
    },
  },
  events: {
    description:
      "Use this when you need to know what scheduled events could move crypto soon: timed macro releases and central-bank " +
      "decisions (UTC and US Central, with why each matters) and dated per-coin catalysts such as network upgrades. Every row " +
      "is sourced. " + FAIR_USE + " JSON.",
    example: {
      kind: "events",
      next: { at_utc: "2026-10-22T23:30:00Z", title: "Japan September CPI", why: "Last national CPI before the BOJ meeting." },
      upcoming_timed: [{ at_utc: "2026-10-28T18:00:00Z", title: "FOMC rate decision", url: "https://www.federalreserve.gov/" }],
      upcoming_by_date: [{ date: "2026-11-03", coin: "XLM", title: "Protocol 30 validator vote" }],
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-24T11:05:00Z"),
      payment: pay("events"),
    },
  },
  trades: {
    description:
      "Use this when you need the full list of Lumi's crypto paper-trade ideas (not advice): entry, stop, targets, leverage and " +
      "reasoning for every idea, newest first. " + FAIR_USE + " JSON.",
    example: {
      kind: "trades",
      count: 8,
      trades: [{ id: "T007", coin: "BTC", direction: "long", entry: 82300, stop: 80800, targets: [84500, 86000], leverage: 3, reasoning: "Reclaim of 82k with funding flat." }],
      ...FRESH("2026-10-22T11:22:28Z", "2026-10-22T23:22:28Z"),
      payment: pay("trades"),
    },
  },
  institutional: {
    description:
      "Use this when you need a sourced daily summary of what regulators, central banks, banks and tokenization firms are " +
      "doing in digital assets and stablecoins, and which networks each move touches. Each item has source URL, date, impact, " +
      "confidence and a confirmed-vs-indirect link type. JSON with markdown; format=md for text. " + FAIR_USE,
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
      ...FRESH("2026-10-22T11:20:32Z", "2026-10-24T11:20:32Z"),
      payment: pay("institutional"),
    },
  },
  vendor_report: {
    description:
      "Use this when you need evidence before paying an x402 API vendor on Lumi's trust list: every free 402-quote check " +
      "(90-day retention) with status, price and latency; paid test-buys with tx hashes and delivered yes/no; latency " +
      "percentiles; uptime over 24h/7d/30d/90d; quoted-price history and score components. Automated observations, not a " +
      "rating. Not charged on bad input or stale data. JSON.",
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
      ...FRESH("2026-10-22T12:30:00Z", "2026-10-24T12:30:00Z"),
      payment: pay("vendor_report"),
    },
  },
  scan: {
    description:
      "Use this when you need to screen the whole crypto market in one paid call instead of 50: the mechanical buy/sell label and " +
      "score, 1h/4h/1d labels, 1h RSI, price and 24h change for every top-50 coin, strongest first, plus label counts and " +
      "breadth. Computed live from exchange candles (1h refreshed about every 13 minutes). " + FAIR_USE + " JSON.",
    example: {
      kind: "scan",
      count: 50,
      label_counts: { "Strong Buy": 3, Buy: 11, Neutral: 21, Sell: 12, "Strong Sell": 3 },
      breadth: { bullish: 14, neutral: 21, bearish: 15, read: "mixed" },
      coins: [{ symbol: "SOL", label: "Buy", score: 0.41, tf: { "1h": "Buy", "4h": "Buy", "1d": "Neutral" }, rsi_1h: 61.2, price_usd: 187.4, change_24h_pct: 2.1 }],
      ...FRESH("2026-10-23T11:02:00Z", "2026-10-23T12:17:00Z"),
      payment: pay("scan"),
    },
  },
  lite: {
    description:
      "Use this when you only need the headline buy/sell read on one crypto coin, cheaply: overall label and score, 1h/4h/1d " +
      "labels and price with 24h change. Top-50 coins (GET /v1/coins), computed live. GET /v1/signal/{coin} adds the full " +
      "indicator breakdown. " + FAIR_USE + " JSON.",
    routeTemplate: "/v1/lite/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "signal_lite",
      coin: { symbol: "BTC", name: "Bitcoin" },
      label: "Neutral",
      score: 0.05,
      price: { usd: 82140, change_24h_pct: 0.4 },
      timeframes: { "1h": { label: "Buy", score: 0.3 }, "4h": { label: "Neutral", score: 0 }, "1d": { label: "Sell", score: -0.3 } },
      ...FRESH("2026-10-23T11:02:00Z", "2026-10-23T12:17:00Z"),
      payment: pay("lite"),
    },
  },
  trust_check: {
    description:
      "Use this before your agent pays an unfamiliar x402 URL: allow / warn / block with reasons, from Lumi's daily CDP Bazaar " +
      "index, free quote checks and paid test-buys. Pass url, and optionally the payTo and amount you were quoted to catch " +
      "address or price mismatches. Observations, not a guarantee. Not charged on bad input. JSON.",
    query: {
      url: { type: "string", description: "The x402 resource URL you are about to pay (required)" },
      payTo: { type: "string", description: "The payTo address from its 402 quote (optional)" },
      amount: { type: "string", description: "The quoted price in USD, e.g. 0.01 (optional)" },
    },
    example: {
      kind: "trust_check",
      query: { url: "https://api.example.com/v1/data", payTo: "0x12ab...89cd" },
      verdict: "warn",
      confidence: "low",
      reasons: [{ code: "last_quote_invalid", severity: "warn", detail: "Lumi's last free quote check did not get a valid x402 quote." }],
      next_steps: { free_lookup: "https://api.lumitrades.io/v1/trust/vendors?url=..." },
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-24T11:00:00Z"),
      payment: pay("trust_check"),
    },
  },
  funding: {
    description:
      "Use this when you need crypto derivatives positioning: current perpetual funding rate for each top-50 coin listed on OKX " +
      "(rate, 8h-normalised, annualised, next funding time), BTC read, median, most positive and negative, refreshed every " +
      "15 minutes. Positive = longs pay shorts. " + FAIR_USE + " JSON.",
    example: {
      kind: "funding",
      venue: "OKX USDT perpetual swaps",
      btc: { symbol: "BTC", rate_pct: 0.0061, interval_hours: 8, rate_8h_pct: 0.0061, annualized_pct: 6.68, read: "near neutral" },
      median_rate_8h_pct: 0.005,
      most_positive: [{ symbol: "PUMP", rate_8h_pct: 0.042 }],
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-23T12:00:00Z"),
      payment: pay("funding"),
    },
  },
  fear_greed: {
    description:
      "Use this when you need crypto market sentiment: the CoinMarketCap Fear & Greed index now, yesterday, last week and last " +
      "month, change vs each, yearly high/low and a 30-day daily series, refreshed every 30 minutes. " + FAIR_USE + " JSON.",
    example: {
      kind: "fear_greed",
      source: "CoinMarketCap",
      value: 38,
      classification: "Fear",
      change: { vs_yesterday: -4, vs_last_week: 6, vs_last_month: -15 },
      series_30d: [{ date: "2026-10-22", value: 42 }],
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-23T17:00:00Z"),
      payment: pay("fear_greed"),
    },
  },
  events_48h: {
    description:
      "Use this when you need to know what could move crypto in the next 48 hours: scheduled macro releases and decisions (Fed, " +
      "CPI, jobs, BOJ...) with exact UTC and US Central times, why each matters and its source, plus dated coin catalysts. " +
      FAIR_USE + " JSON.",
    example: {
      kind: "events_48h",
      count: 2,
      next: { at_utc: "2026-10-23T12:30:00Z", title: "US jobless claims", why: "Labor-market read ahead of the FOMC", source: "DOL" },
      timed: [{ at_utc: "2026-10-23T12:30:00Z", title: "US jobless claims" }],
      ...FRESH("2026-10-23T06:00:00Z", "2026-10-24T06:00:00Z"),
      payment: pay("events_48h"),
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
export function bazaarExtension(route: PaidRoute, arg?: string, query?: Record<string, string>, usd?: string): Record<string, Json> {
  const meta0 = BAZAAR_ROUTES[route];
  const meta = usd ? { ...meta0, example: { ...meta0.example, payment: pay(route, String(Number(usd))) } } : meta0;
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
/** Buyer-keyword headline per route, so Bazaar search and listings show what it is and what it costs first. */
const HEADLINES: Record<PaidRoute, (subject?: string) => string> = {
  signal: (c) => `${c ?? "Crypto"} crypto trading signal (buy/sell score)`,
  levels: (c) => `${c ?? "Crypto"} support and resistance levels with 7-day price projection`,
  slate: () => "Crypto paper-trade ideas (entry, stop, targets)",
  market: () => "Crypto market backdrop (BTC levels, macro, dominance, funding)",
  brief: () => "Daily crypto market brief (BTC, movers, key levels, news)",
  yen: () => "Yen carry-trade risk watch for crypto (USD/JPY, Nikkei, BOJ)",
  sentiment: () => "Crypto sentiment (Fear & Greed, BTC funding, open interest)",
  events: () => "Crypto and macro events calendar (Fed, CPI, BOJ, upgrades)",
  trades: () => "Crypto paper-trade history (entries, stops, targets, status)",
  institutional: () => "Daily institutional & policy brief for digital assets (regulators, banks, tokenization)",
  vendor_report: (v) => `x402 vendor trust report${v ? ` for ${v}` : ""} (uptime, latency, test-buys)`,
  scan: () => "Crypto market scan: buy/sell signals for 50 coins in one call",
  lite: (c) => `${c ?? "Crypto"} lite trading signal (label, score, price)`,
  trust_check: () => "Should I pay this x402 URL? allow/warn/block check",
  funding: () => "Crypto perpetual funding rates (50 coins, OKX)",
  fear_greed: () => "Crypto Fear & Greed index (CoinMarketCap, 30-day history)",
  events_48h: () => "Crypto and macro events in the next 48 hours",
};

/**
 * The 402 resource description that the Bazaar indexes: "<keywords> - $<USD price>. <route description>", capped at
 * BAZAAR_MAX_DESCRIPTION. Without a USD price, falls back to the full endpoint description.
 */
export function resourceDescription(route: PaidRoute, full: string, opts: { subject?: string; usd?: string } = {}): string {
  if (opts.usd) {
    const d = `${HEADLINES[route](opts.subject)} - $${Number(opts.usd)}. ${BAZAAR_ROUTES[route].description}`;
    return d.length <= BAZAAR_MAX_DESCRIPTION ? d : d.slice(0, BAZAAR_MAX_DESCRIPTION - 1).replace(/\s+\S*$/, "") + "…";
  }
  if (full.length <= BAZAAR_MAX_DESCRIPTION) return full;
  return BAZAAR_ROUTES[route].description.slice(0, BAZAAR_MAX_DESCRIPTION);
}
