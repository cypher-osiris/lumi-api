#!/usr/bin/env node
/**
 * lumi-trades-mcp: stdio MCP server for the Lumi API (https://api.lumitrades.io).
 * Paid tools pay per call via x402 with YOUR wallet: XRP/RLUSD/USDC on the XRP Ledger (XRPL_SEED) or USDC on Base (EVM_PRIVATE_KEY),
 * within per-call caps and a session budget.
 * Analytics and education only, not financial advice.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, loadSettings, assetLabel } from "./lumi.js";

const VENDOR_LOOKUP_DESCRIPTION =
  "Free. Check an x402 seller before you pay it: pass url (the resource you are about to buy), domain, or payTo (the address in its 402 quote, case-insensitive). Lumi ingests the full CDP x402 Bazaar catalog daily and runs a free, unpaid 402-quote check of every listing at least daily (valid quote, price and payTo vs the listing, latency, domain age), labelled 'quote-verified, low confidence', plus small paid test-buys confirmed on-chain, labelled 'purchase-verified'. Observations, not ratings; no match is not a negative signal. With no arguments: the curated XRPL vendor scores and catalog counts; vendor_id gives one curated vendor's full evidence.";

export const VERSION = "0.5.0";

/** Paid tools: name -> API path builder + description (prices are read live from the API's 402 quote). */
export const PAID_TOOLS = [
  {
    name: "lumi_brief",
    path: (a) => `/v1/brief${a.format === "md" ? "?format=md" : ""}`,
    input: { format: z.enum(["json", "md"]).optional().describe("json (default) or md for ready-to-post markdown") },
    description:
      "Today's crypto market brief from Lumi: BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, top/bottom movers, key levels for 13 coins, yen watch, events in the next 48h, Lumi's active paper trades, sourced news. Paid: $0.03 per call (USDC on Base or XRPL, RLUSD, or 0.02 XRP).",
  },
  {
    name: "lumi_signal",
    path: (a) => `/v1/signal/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id: XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI") },
    description: "Mechanical buy/sell read for one coin: overall label + score, 1h/4h/1d labels and indicators (RSI, MACD, EMA, Bollinger, StochRSI, volume). Paid: $0.01 per call (USDC on Base or XRPL, RLUSD, or 0.005 XRP).",
  },
  {
    name: "lumi_levels",
    path: (a) => `/v1/levels/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id, e.g. XRP") },
    description: "Lumi's support/resistance levels, bias, 7-day bull/base/bear projection, commentary, catalysts and sources for one coin. Paid: $0.01 per call (or 0.005 XRP).",
  },
  { name: "lumi_slate", path: () => "/v1/slate", input: {}, description: "Lumi's current paper-trade ideas (entry, stop, targets, leverage, conviction) and 'no setup' notes. Paid: $0.02 per call (or 0.01 XRP)." },
  { name: "lumi_market", path: () => "/v1/market", input: {}, description: "BTC backdrop (levels, projection, signal), macro (yen note, total cap, dominance, Fear & Greed, funding) and breadth. Paid: $0.02 per call (or 0.01 XRP)." },
  { name: "lumi_macro_yen", path: () => "/v1/macro/yen", input: {}, description: "Yen carry-trade watch: USD/JPY, Nikkei 225, rule-based carry-trade risk (low/watch/elevated) around 155, Japan events (BOJ, CPI). Paid: $0.015 per call (or 0.01 XRP)." },
  { name: "lumi_sentiment", path: () => "/v1/sentiment", input: {}, description: "CoinMarketCap Fear & Greed, BTC perp funding with a plain-English read, open interest, total cap/dominance, breadth across 13 coins. Paid: $0.01 per call (or 0.005 XRP)." },
  { name: "lumi_events", path: () => "/v1/events", input: {}, description: "Sourced upcoming macro/crypto events (timed releases in UTC + US Central, and dated per-coin catalysts). Paid: $0.01 per call (or 0.005 XRP)." },
  { name: "lumi_trades", path: () => "/v1/trades", input: {}, description: "Lumi's paper-trade history as a raw list: every idea with entry, stop, targets, leverage, status and reasoning. Paid: $0.02 per call (or 0.01 XRP)." },
  {
    name: "lumi_institutional_brief",
    path: (a) => `/v1/institutional${a.format === "md" ? "?format=md" : ""}`,
    input: { format: z.enum(["json", "md"]).optional().describe("json (default) or md for ready-to-read markdown") },
    description:
      "Daily Institutional & Policy Brief (premium): what BIS, IMF, US Treasury/OCC, Fed, SEC, CFTC, JPMorgan (Kinexys), SBI, Cross River, Securitize, R3 " +
      "and other banks, central banks and tokenization firms did in the last days, and how each move maps to XRP, XLM, XDC, QNT, AXL and HBAR (plus RLUSD/USDC). " +
      "Every item is dated and sourced, with why it matters, impact and confidence, and a link_type that separates confirmed links from Lumi's " +
      "indirect-alignment analysis (institution goals vs token mission, both sides quoted). Includes a per-token map, connections, no-news notes and " +
      "what to watch next. Refreshed daily; never sold stale. Paid: $0.25 per call (USDC on Base or XRPL, RLUSD, or 0.19 XRP); " +
      "allowed by the default caps (LUMI_MAX_USD_PER_CALL 0.30, LUMI_MAX_XRP_PER_CALL 0.25). Not financial advice.",
  },
  {
    name: "lumi_vendor_report",
    path: (a) => `/v1/trust/vendors/${encodeURIComponent(a.vendor_id)}/report`,
    input: { vendor_id: z.string().regex(/^[a-z0-9-]{1,64}$/).describe("Vendor id from lumi_vendor_scores, e.g. asksurf") },
    description:
      "Detailed report on one x402 vendor from Lumi's trust list: full observation history (every free 402-quote check over 90 days, every paid test-buy with tx hash and delivered yes/no), " +
      "latency stats and 7-day trend, uptime % (24h/7d/30d/90d) and daily series, quoted-price history, verified agent reports, vendor replies, sample sizes and confidence labels. " +
      "Automated observations, not a rating. Paid: $0.02 per call (or 0.015 XRP). The free summary is lumi_vendor_scores.",
  },
];

const DISCLAIMER = "Lumi Trades data: analytics and education only, not financial advice. Trade ideas are paper trades.";
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

export function buildServer(client) {
  const server = new McpServer({ name: "lumi-trades-mcp", version: VERSION });
  const s = client.settings;

  server.registerTool(
    "lumi_catalog",
    { title: "Lumi: endpoints and prices (free)", description: "Free. Lists Lumi API endpoints, live prices (USD; XRP / RLUSD / USDC on the XRP Ledger or USDC on Base), payment settings of this MCP server and the caller wallet address.", inputSchema: {} },
    async () => {
      const r = await client.free("/");
      const a = assetLabel(s.asset);
      return text({
        api: s.apiUrl,
        network: s.rail === "base" ? "eip155:8453 (Base)" : s.network,
        pay_with: a,
        wallet: (await client.walletAddress()) ?? "not configured (set XRPL_SEED for the XRP Ledger or EVM_PRIVATE_KEY for USDC on Base to enable paid tools)",
        caps: {
          per_call: s.asset === "XRP" ? `${s.maxXrpPerCall} XRP (LUMI_MAX_XRP_PER_CALL)` : `${s.maxUsdPerCall} ${a} (LUMI_MAX_USD_PER_CALL)`,
          session_budget: `${s.budget} ${a} (LUMI_SESSION_BUDGET)`,
          spent: `${client.ledger.spent} ${a}`,
        },
        endpoints: r.body?.paid_endpoints?.map((e) => ({ path: e.path, prices: e.prices, summary: e.summary })) ?? r.body,
        guarantee: r.body?.guarantee,
      });
    },
  );

  server.registerTool(
    "lumi_coins",
    { title: "Lumi: supported coins (free)", description: "Free. The 13 coins Lumi covers (tickers and CoinGecko ids).", inputSchema: {} },
    async () => {
      const r = await client.free("/v1/coins");
      return text(r.body?.coins?.map((c) => ({ symbol: c.symbol, id: c.id, name: c.name, group: c.group })) ?? r.body);
    },
  );

  server.registerTool(
    "lumi_samples",
    {
      title: "Lumi: free samples of every paid product",
      description:
        "Free. A truncated, clearly labelled SAMPLE of each paid product (signal, levels, slate, market, brief, yen, sentiment, events, trades, institutional brief, vendor report) with its USD price and full URL, so you can judge it before paying. Lists are cut to 2 entries; up to 10 minutes old. Pass route to get one product.",
      inputSchema: { route: z.string().regex(/^[a-z_]{1,32}$/).optional().describe("Optional product route, e.g. institutional or signal") },
    },
    async ({ route }) => {
      const r = await client.free("/v1/samples");
      if (!route || r.status !== 200) return text(r.body);
      const one = (r.body?.products || []).find((p) => p.route === route);
      return text(one ? { label: r.body.label, ...one } : { error: "unknown route", routes: (r.body?.products || []).map((p) => p.route) });
    },
  );

  server.registerTool(
    "lumi_quote",
    {
      title: "Lumi: price check without paying (free)",
      description: "Free. Shows the x402 price quote (XRP / RLUSD / USDC on the XRP Ledger, USDC on Base) for any Lumi paid path, e.g. /v1/brief, without paying. A 503 means the data is not fresh right now and the call would not be sold.",
      inputSchema: { path: z.string().regex(/^\/v1\//).describe("Paid API path, e.g. /v1/brief or /v1/signal/XRP") },
    },
    async ({ path }) => text(await client.quote(path)),
  );

  server.registerTool(
    "lumi_vendor_scores",
    {
      title: "Lumi: x402 vendor observations (free)",
      description: VENDOR_LOOKUP_DESCRIPTION,
      inputSchema: {
        url: z.string().max(500).optional().describe("Resource URL you are about to pay, e.g. https://example.com/api/data"),
        domain: z.string().max(253).optional().describe("Seller host or domain, e.g. example.com"),
        payTo: z.string().max(120).optional().describe("payTo address from the seller's 402 quote (0x... or r...)"),
        vendor_id: z.string().regex(/^[a-z0-9-]{1,64}$/).optional().describe("Optional curated vendor id, e.g. asksurf"),
      },
    },
    async ({ url, domain, payTo, vendor_id }) => {
      let path = "/v1/trust/vendors";
      if (url || domain || payTo) {
        const q = new URLSearchParams();
        if (url) q.set("url", url);
        if (domain) q.set("domain", domain);
        if (payTo) q.set("payTo", payTo);
        path += "?" + q.toString();
      } else if (vendor_id) path += "/" + encodeURIComponent(vendor_id);
      const r = await client.free(path);
      return r.status === 200 ? text(r.body) : { ...text({ status: r.status, body: r.body }), isError: true };
    },
  );

  for (const t of PAID_TOOLS) {
    server.registerTool(
      t.name,
      { title: `Lumi: ${t.name.replace(/^lumi_/, "").replace(/_/g, " ")} (paid)`, description: `${t.description} Pays with your own wallet via x402 (XRPL_SEED or EVM_PRIVATE_KEY) within the configured caps.`, inputSchema: t.input },
      async (args) => {
        const fmtMd = (t.name === "lumi_brief" || t.name === "lumi_institutional_brief") && args?.format === "md";
        const r = await client.paid(t.path(args ?? {}), fmtMd ? "text/markdown" : "application/json");
        if (!r.paid) return { ...text(r), isError: r.status !== 402 || !!r.error };
        const receipt = { tx: r.receipt?.transaction, network: r.receipt?.network, spent_this_session: r.spent_this_session };
        if (typeof r.body === "string") return text(`${r.body}\n\n[x402 receipt: ${JSON.stringify(receipt)}]`);
        return text({ ...r.body, mcp_receipt: receipt, ...(t.name === "lumi_vendor_report" ? {} : { note: DISCLAIMER }) });
      },
    );
  }
  return server;
}

async function main() {
  const settings = loadSettings();
  const client = createClient(settings);
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP channel. Never print the seed.
  const wallet = await client.walletAddress();
  const where = settings.rail === "base" ? "Base (eip155:8453)" : settings.network;
  console.error(`lumi-trades-mcp ${VERSION}: ${settings.apiUrl}, paying in ${assetLabel(settings.asset)} (${where})${wallet ? ` from ${wallet}` : " (no wallet configured: free tools and quotes only)"}`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`lumi-trades-mcp: ${e?.message ?? e}`);
    process.exit(1);
  });
}
