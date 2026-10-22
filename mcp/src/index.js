#!/usr/bin/env node
/**
 * lumi-trades-mcp: stdio MCP server for the Lumi API (https://api.lumitrades.io).
 * Paid tools pay per call via x402 on the XRP Ledger with YOUR wallet (XRPL_SEED), within per-call caps and a session budget.
 * Analytics and education only, not financial advice.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, loadSettings } from "./lumi.js";

export const VERSION = "0.3.0";

/** Paid tools: name -> API path builder + description (prices are read live from the API's 402 quote). */
export const PAID_TOOLS = [
  {
    name: "lumi_brief",
    path: (a) => `/v1/brief${a.format === "md" ? "?format=md" : ""}`,
    input: { format: z.enum(["json", "md"]).optional().describe("json (default) or md for ready-to-post markdown") },
    description:
      "Today's crypto market brief from Lumi: BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, top/bottom movers, key levels for 13 coins, yen watch, events in the next 48h, Lumi's paper trades and record, sourced news. Paid (~0.02 XRP / 0.03 RLUSD).",
  },
  {
    name: "lumi_signal",
    path: (a) => `/v1/signal/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id: XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI") },
    description: "Mechanical buy/sell read for one coin: overall label + score, 1h/4h/1d labels and indicators (RSI, MACD, EMA, Bollinger, StochRSI, volume). Paid (~0.005 XRP).",
  },
  {
    name: "lumi_levels",
    path: (a) => `/v1/levels/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id, e.g. XRP") },
    description: "Lumi's support/resistance levels, bias, 7-day bull/base/bear projection, commentary, catalysts and sources for one coin. Paid (~0.005 XRP).",
  },
  { name: "lumi_slate", path: () => "/v1/slate", input: {}, description: "Lumi's current paper-trade ideas (entry, stop, targets, leverage, conviction) and 'no setup' notes. Paid (~0.01 XRP)." },
  { name: "lumi_market", path: () => "/v1/market", input: {}, description: "BTC backdrop (levels, projection, signal), macro (yen note, total cap, dominance, Fear & Greed, funding) and breadth. Paid (~0.01 XRP)." },
  { name: "lumi_macro_yen", path: () => "/v1/macro/yen", input: {}, description: "Yen carry-trade watch: USD/JPY, Nikkei 225, rule-based carry-trade risk (low/watch/elevated) around 155, Japan events (BOJ, CPI). Paid (~0.01 XRP)." },
  { name: "lumi_sentiment", path: () => "/v1/sentiment", input: {}, description: "CoinMarketCap Fear & Greed, BTC perp funding with a plain-English read, open interest, total cap/dominance, breadth across 13 coins. Paid (~0.005 XRP)." },
  { name: "lumi_events", path: () => "/v1/events", input: {}, description: "Sourced upcoming macro/crypto events (timed releases in UTC + US Central, and dated per-coin catalysts). Paid (~0.005 XRP)." },
  { name: "lumi_trades", path: () => "/v1/trades", input: {}, description: "Lumi's full paper-trade history and honest computed track record (win rate, P&L, by coin/direction, equity curve). Paid (~0.01 XRP)." },
  {
    name: "lumi_institutional_brief",
    path: (a) => `/v1/institutional${a.format === "md" ? "?format=md" : ""}`,
    input: { format: z.enum(["json", "md"]).optional().describe("json (default) or md for ready-to-read markdown") },
    description:
      "Daily Institutional & Policy Brief (premium): what BIS, IMF, US Treasury/OCC, Fed, SEC, CFTC, JPMorgan (Kinexys), SBI, Cross River, Securitize, R3 " +
      "and other banks, central banks and tokenization firms did in the last days, and how each move maps to XRP, XLM, XDC, QNT, AXL and HBAR (plus RLUSD/USDC). " +
      "Every item is dated and sourced, with why it matters, impact and confidence, and a link_type that separates confirmed links from Lumi's " +
      "indirect-alignment analysis (institution goals vs token mission, both sides quoted). Includes a per-token map, connections, no-news notes and " +
      "what to watch next. Refreshed daily; never sold stale. Paid (~0.19 XRP / 0.25 RLUSD / 0.25 USDC): raise LUMI_MAX_XRP_PER_CALL to 0.2+ " +
      "(or LUMI_MAX_USD_PER_CALL to 0.25+) to allow it. Not financial advice.",
  },
];

const DISCLAIMER = "Lumi Trades data: analytics and education only, not financial advice. Trade ideas are paper trades.";
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

export function buildServer(client) {
  const server = new McpServer({ name: "lumi-trades-mcp", version: VERSION });
  const s = client.settings;

  server.registerTool(
    "lumi_catalog",
    { title: "Lumi: endpoints and prices (free)", description: "Free. Lists Lumi API endpoints, live prices (XRP / RLUSD / USDC), payment settings of this MCP server and the caller wallet address.", inputSchema: {} },
    async () => {
      const r = await client.free("/");
      return text({
        api: s.apiUrl,
        network: s.network,
        pay_with: s.asset,
        wallet: client.walletAddress() ?? "not configured (set XRPL_SEED to enable paid tools)",
        caps: { per_call: s.asset === "XRP" ? `${s.maxXrpPerCall} XRP` : `${s.maxUsdPerCall} ${s.asset}`, session_budget: `${s.budget} ${s.asset}`, spent: `${client.ledger.spent} ${s.asset}` },
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
    "lumi_quote",
    {
      title: "Lumi: price check without paying (free)",
      description: "Free. Shows the x402 price quote (XRP / RLUSD / USDC) for any Lumi paid path, e.g. /v1/brief, without paying. A 503 means the data is not fresh right now and the call would not be sold.",
      inputSchema: { path: z.string().regex(/^\/v1\//).describe("Paid API path, e.g. /v1/brief or /v1/signal/XRP") },
    },
    async ({ path }) => text(await client.quote(path)),
  );

  server.registerTool(
    "lumi_vendor_scores",
    {
      title: "Lumi: x402 vendor observations (free)",
      description:
        "Free. Lumi's automated observations of other x402 sellers on the XRP Ledger: free 402-quote checks every 30 min plus small paid test-buys, " +
        "with timestamps, tx hashes and sample sizes. Scores are observations, not ratings; few samples = low confidence. Pass vendor_id for one vendor's full evidence.",
      inputSchema: { vendor_id: z.string().regex(/^[a-z0-9-]{1,64}$/).optional().describe("Optional vendor id from the list, e.g. asksurf") },
    },
    async ({ vendor_id }) => {
      const r = await client.free(vendor_id ? `/v1/trust/vendors/${encodeURIComponent(vendor_id)}` : "/v1/trust/vendors");
      return r.status === 200 ? text(r.body) : { ...text({ status: r.status, body: r.body }), isError: true };
    },
  );

  for (const t of PAID_TOOLS) {
    server.registerTool(
      t.name,
      { title: `Lumi: ${t.name.replace(/^lumi_/, "").replace(/_/g, " ")} (paid)`, description: `${t.description} Pays with your XRPL wallet via x402 within the configured caps.`, inputSchema: t.input },
      async (args) => {
        const fmtMd = (t.name === "lumi_brief" || t.name === "lumi_institutional_brief") && args?.format === "md";
        const r = await client.paid(t.path(args ?? {}), fmtMd ? "text/markdown" : "application/json");
        if (!r.paid) return { ...text(r), isError: r.status !== 402 || !!r.error };
        const receipt = { tx: r.receipt?.transaction, network: r.receipt?.network, spent_this_session: r.spent_this_session };
        if (typeof r.body === "string") return text(`${r.body}\n\n[x402 receipt: ${JSON.stringify(receipt)}]`);
        return text({ ...r.body, mcp_receipt: receipt, note: DISCLAIMER });
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
  console.error(`lumi-trades-mcp ${VERSION}: ${settings.apiUrl} on ${settings.network}, paying in ${settings.asset}${settings.seed ? ` from ${client.walletAddress()}` : " (no XRPL_SEED: free tools and quotes only)"}`);
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
