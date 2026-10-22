/** Free, human- and agent-facing documents: index, skill.md, discovery manifests, OpenAPI. */

import type { Config } from "./config";
import { EXPLORERS, dropsToXrp } from "./config";
import { PAID_ENDPOINTS, priceTable } from "./catalog";
import { DISCLAIMER, SOURCE, type CoinRef } from "./views";

export const VERSION = "0.8.0";

export function indexDoc(cfg: Config, base: string, coins: CoinRef[]) {
  return {
    name: "Lumi API",
    version: VERSION,
    description:
      "Pay-per-call crypto market reads from Lumi Trades (lumitrades.io) for AI agents. " +
      `No API keys or accounts: each paid call is settled in ${settledIn(cfg)} via the x402 protocol (HTTP 402, exact scheme).`,
    human_summary:
      "Lumi publishes indicator signals, support/resistance levels, a paper-trade slate and a BTC/macro backdrop for 13 coins, plus a daily " +
      "market brief, a yen carry-trade watch, a sentiment snapshot (CoinMarketCap Fear & Greed + funding), an events calendar and its full paper-trade track record, " +
      "plus a premium daily Institutional & Policy Brief (BIS, IMF, US Treasury/regulators, JPMorgan, SBI, Cross River, Securitize, R3 and others mapped to XRP, XLM, XDC, QNT, AXL, HBAR). " +
      `Agents call an endpoint, receive HTTP 402 with a price in XRP${cfg.ious.length ? ` (accepts[0])${cfg.ious.map((o, i) => `, ${o.symbol} (accepts[${i + 1}])`).join("")}` : ""}` +
      `${cfg.evm ? ` or USDC on ${cfg.evm.networkName} (accepts[${cfg.ious.length + 1}])` : ""}, sign a small XRPL Payment${cfg.evm ? " or an EIP-3009 USDC authorization" : ""}, retry, and get JSON back.`,
    source: SOURCE,
    payment: {
      protocol: "x402",
      x402Version: 2,
      scheme: "exact",
      network: cfg.network,
      network_name: cfg.networkName,
      asset: "XRP",
      assets: assetsInfo(cfg),
      pay_to: cfg.payTo,
      facilitator: cfg.facilitatorUrl,
      source_tag: cfg.sourceTag,
      headers: { challenge: "PAYMENT-REQUIRED", payment: "PAYMENT-SIGNATURE", receipt: "PAYMENT-RESPONSE" },
      explorer: EXPLORERS[cfg.network],
      networks: paymentNetworks(cfg),
    },
    guarantee:
      "You only pay when you get data: inputs are fetched and validated (present, non-empty, fresh) before any 402 quote; " +
      "otherwise 503 'Not charged.' and no payment can be settled. The paid body is built before settlement.",
    free_endpoints: [
      { method: "GET", path: "/", summary: "This index" },
      { method: "GET", path: "/health", summary: "Liveness + config summary" },
      { method: "GET", path: "/skill.md", summary: "Agent guide: what is offered, prices, how to pay, example code" },
      { method: "GET", path: "/.well-known/x402", summary: "x402 discovery manifest" },
      { method: "GET", path: "/.well-known/agent-card.json", summary: "A2A agent card (alias /.well-known/agent.json)" },
      { method: "GET", path: "/openapi.json", summary: "OpenAPI 3.1 description with x-payment-info" },
      { method: "GET", path: "/v1/coins", summary: "Supported coins" },
      { method: "GET", path: "/v1/trust/vendors", summary: "Lumi's automated observations of other x402 vendors (402-quote checks every 30 min, paid test-buys with tx evidence, sample sizes)" },
      { method: "GET", path: "/v1/trust/vendors/{id}", summary: "One vendor: observations with evidence, latest probes, verified agent reports, vendor replies" },
      { method: "GET", path: "/v1/trust/vendors/{id}/report", summary: "Paid ($0.02, x402): full observation history for one vendor; listed under paid_endpoints" },
      { method: "GET", path: "/v1/trust/methodology", summary: "How trust observations and scores are computed; how to report and how vendors reply" },
      { method: "POST", path: "/v1/reports", summary: "Report a paid call to a listed vendor (counts only with an on-ledger payment + payer signature)" },
      { method: "POST", path: "/v1/tips", summary: "Send Lumi a private tip (stored privately; never published or returned)" },
      { method: "POST", path: "/v1/trust/replies", summary: "Vendor right to reply (signed by a listed pay-to address), or email hello@lumitrades.io" },
      { method: "POST", path: "/mcp", summary: "Remote MCP server (Streamable HTTP): free tools for everyone; paid tools return the price and how to pay" },
      { method: "POST", path: "/a2a", summary: "A2A JSON-RPC endpoint (SendMessage / message/send): free skills answered inline, paid skills return x402 terms" },
    ],
    mcp: mcpInfo(base),
    a2a: { agent_card: `${base}/.well-known/agent-card.json`, endpoint: `${base}/a2a`, protocol_versions: ["1.0", "0.3"], binding: "JSONRPC" },
    paid_endpoints: priceTable(cfg),
    coins: coins.map((c) => c.symbol),
    docs: `${base}/skill.md`,
    disclaimer: DISCLAIMER,
  };
}

export function wellKnownX402(cfg: Config, base: string) {
  // Follows draft-hawkins-x402-dns-discovery (kind/resource-server manifest).
  // `resources` lists concrete example URLs, since templates are not fetchable.
  return {
    x402Version: 2,
    kind: "resource-server",
    name: "Lumi API",
    description: `Pay-per-call crypto market reads from lumitrades.io (signals, levels, paper-trade slate + track record, macro, daily brief, yen carry-trade watch, sentiment, events, daily Institutional & Policy Brief, plus a detailed x402 vendor report from Lumi's trust observations), settled in ${settledIn(cfg)}.`,
    resources: PAID_ENDPOINTS.map((e) => ({
      name: e.name,
      url: `${base}${e.example}`,
      template: `${base}${e.template}`,
      mimeType: "application/json",
      method: e.method,
      description: e.summary,
      accepts: [
        {
          scheme: "exact",
          network: cfg.network,
          asset: "XRP",
          amount: cfg.pricesDrops[e.route],
          amount_xrp: dropsToXrp(cfg.pricesDrops[e.route]),
          payTo: cfg.payTo,
        },
        ...cfg.ious.map((o) => ({
          scheme: "exact",
          network: cfg.network,
          asset: o.currency,
          asset_symbol: o.symbol,
          issuer: o.issuer,
          amount: o.prices[e.route],
          payTo: cfg.payTo,
        })),
        ...(cfg.evm
          ? [{
              scheme: "exact",
              network: cfg.evm.network,
              asset: cfg.evm.asset,
              asset_symbol: "USDC",
              amount: cfg.evm.amounts[e.route],
              amount_usdc: cfg.evm.prices[e.route],
              payTo: cfg.evm.payTo,
              extra: { name: cfg.evm.eip712.name, version: cfg.evm.eip712.version },
            }]
          : []),
      ],
    })),
    facilitators: [cfg.facilitatorUrl, ...(cfg.evm ? [...(cfg.evm.cdp ? [cfg.evm.cdp.url] : []), cfg.evm.facilitatorUrl] : [])],
    networks: paymentNetworks(cfg),
    agent_card: `${base}/.well-known/agent-card.json`,
    openapi: `${base}/openapi.json`,
    docs: `${base}/skill.md`,
    mcp: { url: `${base}/mcp`, transport: "streamable-http" },
    attestation: { type: "none" },
    contact: "https://lumitrades.io",
    updated: new Date().toISOString(),
  };
}

export function openApi(cfg: Config, base: string, coins: CoinRef[]) {
  const coinParam = {
    name: "coin",
    in: "path",
    required: true,
    description: "Ticker or CoinGecko id (case-insensitive)",
    schema: { type: "string", enum: coins.map((c) => c.symbol) },
    example: "xrp",
    examples: { xrp: { value: "xrp" }, btc: { value: "btc" } },
  };
  const paths: Record<string, unknown> = {
    "/v1/coins": { get: { summary: "List supported coins (free)", security: [], responses: { "200": { description: "OK" } } } },
    "/health": { get: { summary: "Health (free)", security: [], responses: { "200": { description: "OK" } } } },
    ...trustPaths(),
  };
  for (const e of PAID_ENDPOINTS) {
    paths[e.template] = {
      get: {
        operationId: e.route,
        summary: e.name,
        description: e.summary,
        parameters: e.template.includes("{coin}")
          ? [coinParam]
          : e.template.includes("{id}")
          ? [{ name: "id", in: "path", required: true, description: "Vendor id from GET /v1/trust/vendors (free)", schema: { type: "string", pattern: "^[a-z0-9-]{1,64}$" }, example: "scalpstream", examples: { scalpstream: { value: "scalpstream" } } }]
          : e.route === "brief" || e.route === "institutional"
            ? [{ name: "format", in: "query", required: false, description: "json (default) or md for text/markdown", schema: { type: "string", enum: ["json", "md"] } }]
            : [],
        ...(e.template.includes("{coin}")
          ? { "x-example-url": `${base}${e.template.replace("{coin}", "xrp")}` }
          : e.template.includes("{id}")
          ? { "x-example-url": `${base}${e.template.replace("{id}", "scalpstream")}` }
          : {}),
        "x-payment-info": {
          protocols: ["x402"],
          price: { mode: "fixed", currency: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]) },
          scheme: "exact",
          network: cfg.network,
          asset: "XRP",
          amount_drops: cfg.pricesDrops[e.route],
          payTo: cfg.payTo,
          ...(cfg.ious.length || cfg.evm
            ? {
                alternatives: [
                  ...cfg.ious.map((o) => ({
                    price: { mode: "fixed", currency: o.symbol, amount: o.prices[e.route] },
                    network: cfg.network,
                    asset: o.currency,
                    issuer: o.issuer,
                    amount: o.prices[e.route],
                  })),
                  ...(cfg.evm
                    ? [{
                        price: { mode: "fixed", currency: "USDC", amount: cfg.evm.prices[e.route] },
                        scheme: "exact",
                        network: cfg.evm.network,
                        asset: cfg.evm.asset,
                        amount: cfg.evm.amounts[e.route],
                        payTo: cfg.evm.payTo,
                      }]
                    : []),
                ],
              }
            : {}),
        },
        responses: {
          "200": { description: "Paid data (JSON). Settlement receipt in the PAYMENT-RESPONSE header." },
          "402": { description: "Payment required. x402 v2 PaymentRequired in the body and the PAYMENT-REQUIRED header." },
          ...(e.template.includes("{")
            ? { "400": { description: "Path template not filled in (a literal {coin} or {id}); the body gives an example URL (never charged)." } }
            : {}),
          "404": { description: e.template.includes("{id}") ? "Unknown vendor (never charged)." : "Unknown coin (never charged)." },
          "503": { description: e.route === "vendor_report" ? "No observation of this vendor in the last 48 h, so the report is not sold (never charged)." : "Inputs missing or stale (never charged)." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Lumi API",
      version: VERSION,
      contact: { name: "Lumi Trades", url: "https://lumitrades.io", email: "hello@lumitrades.io" },
      description: `Pay-per-call crypto market reads from lumitrades.io, paid in ${settledIn(cfg)} via x402.`,
      "x-guidance":
        `Use this API when you need a current technical read or trade-idea context for ${coins.map((c) => c.symbol).join(", ")}. ` +
        "GET /v1/coins (free) lists supported coins. GET /v1/signal/{coin} gives the indicator-based buy/sell read; " +
        "GET /v1/levels/{coin} gives support/resistance, a 7-day projection and commentary; GET /v1/slate gives current paper-trade ideas; " +
        "GET /v1/market gives the BTC and macro backdrop; GET /v1/brief gives today's whole market brief (JSON + markdown); " +
        "GET /v1/macro/yen gives USD/JPY, Nikkei and a carry-trade risk level; GET /v1/sentiment gives CoinMarketCap Fear & Greed, funding and breadth; " +
        "GET /v1/events gives sourced upcoming macro/crypto events; GET /v1/trades gives the full paper-trade history and track record; " +
        "GET /v1/institutional gives the daily Institutional & Policy Brief (BIS, IMF, US regulators, banks and tokenization firms mapped to XRP, XLM, XDC, QNT, AXL, HBAR, confirmed vs indirect-alignment links). Each paid call is one x402 v2 'exact' payment on the XRP Ledger " +
        (cfg.ious.length
          ? "in XRP (accepts[0])" + cfg.ious.map((o, i) => ` or ${o.symbol} (accepts[${i + 1}], issuer ${o.issuer})`).join("") + " "
          : "in XRP ") +
        `(${cfg.network})` +
        (cfg.evm ? `, or one x402 v2 'exact' payment in USDC on ${cfg.evm.networkName} (${cfg.evm.network}, token ${cfg.evm.asset}, last accepts entry)` : "") +
        `; unknown coins return 404 before any payment is requested. Full guide: ${base}/skill.md. Analytics only, not financial advice.`,
    },
    servers: [{ url: base }],
    externalDocs: { description: "Agent guide", url: `${base}/skill.md` },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Owner key, only for owner-only endpoints. Paid endpoints use x402 (see x-payment-info); free endpoints need no auth." },
      },
    },
  };
}

function trustPaths(): Record<string, unknown> {
  const json = (props: Record<string, unknown>, required: string[]) => ({ required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } });
  const r = (codes: Record<string, string>) => Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { description: v }]));
  const tag = ["trust"];
  return {
    "/v1/trust/vendors": { get: { tags: tag, security: [], summary: "x402 vendor observations (free)", description: "Lumi's automated observations of other x402 sellers: free 402-quote checks every 30 min and small paid test-buys, with timestamps, tx hashes and sample sizes. Listed in allowlist order, not ranked. Observations, not ratings.", responses: r({ "200": "OK" }) } },
    "/v1/trust/vendors/{id}": { get: { tags: tag, security: [], summary: "One vendor's observations and evidence (free)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]{1,64}$" }, example: "scalpstream" }], responses: r({ "200": "OK", "404": "Unknown vendor" }) } },
    "/v1/trust/methodology": { get: { tags: tag, security: [], summary: "Methodology, report format and right to reply (free)", responses: r({ "200": "OK" }) } },
    "/v1/reports": {
      post: {
        tags: tag,
        summary: "Report a paid call to a listed vendor",
        security: [],
        description: "Counts only when verified: the payment must be validated on-ledger (sent by `reporter` to a listed pay-to address, within 7 days) and `signature` must sign `lumi-report:<network>:<tx_hash>` with the payer's key. Unverified submissions are stored privately and never shown. 5/min and 20/day per IP.",
        requestBody: json({
          vendor_id: { type: "string" }, network: { type: "string", enum: ["xrpl:0", "eip155:8453"], default: "xrpl:0" }, tx_hash: { type: "string" }, reporter: { type: "string" }, signature: { type: "string" },
          outcome: { type: "string", enum: ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other"] }, http_status: { type: "integer" }, response_excerpt: { type: "string", maxLength: 4000 },
        }, ["vendor_id", "tx_hash", "reporter", "outcome", "signature"]),
        responses: r({ "201": "Verified and recorded", "400": "Invalid input", "404": "Unknown vendor", "409": "A verified report for this tx exists", "422": "Not verified (stored privately, not shown)", "429": "Rate limited", "503": "Ledger unreachable; nothing stored" }),
      },
    },
    "/v1/tips": {
      post: {
        tags: tag,
        summary: "Private tip to Lumi",
        security: [],
        description: "Stored privately. Never shown, published, or returned by any endpoint. 3/min and 10/day per IP.",
        requestBody: json({ text: { type: "string", minLength: 10, maxLength: 1000 }, coins: { type: "array", items: { type: "string" }, maxItems: 10 }, source_urls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 5 } }, ["text"]),
        responses: r({ "202": "Received", "400": "Invalid input", "429": "Rate limited" }),
      },
    },
    "/v1/trust/replies": {
      post: {
        tags: tag,
        summary: "Vendor right to reply",
        security: [],
        description: "Sign `lumi-reply:<vendor_id>:<sha256 hex of text>` with the key of a pay-to address listed for the vendor (XRPL: master key or RegularKey, include public_key; Base: EIP-191). Verified replies are shown with the vendor entry. Or email hello@lumitrades.io.",
        requestBody: json({ vendor_id: { type: "string" }, text: { type: "string", maxLength: 1000 }, network: { type: "string", enum: ["xrpl:0", "eip155:8453"] }, address: { type: "string" }, public_key: { type: "string" }, signature: { type: "string" } }, ["vendor_id", "text", "address", "signature"]),
        responses: r({ "201": "Verified and shown", "400": "Invalid input", "404": "Unknown vendor", "422": "Signature or address not verified (not stored)", "429": "Rate limited" }),
      },
    },
    "/v1/trust/observations": { post: { tags: tag, summary: "Owner only: record a Lumi test-buy (ledger-checked)", security: [{ bearer: [] }], responses: r({ "201": "Recorded", "200": "Duplicate tx", "401": "Unauthorized", "422": "Ledger check failed" }) } },
  };
}

function mcpInfo(base: string) {
  return {
    remote: { url: `${base}/mcp`, transport: "streamable-http", stateless: true },
    stdio: { package: "lumi-trades-mcp", command: "npx -y lumi-trades-mcp", pays_with: "your XRPL wallet (XRPL_SEED), within per-call caps and a session budget" },
    registry: "io.github.cypher-osiris/lumi-trades-mcp",
    tools: {
      free: ["lumi_catalog", "lumi_coins", "lumi_quote", "lumi_vendor_scores"],
      paid: ["lumi_brief", "lumi_signal", "lumi_levels", "lumi_slate", "lumi_market", "lumi_macro_yen", "lumi_sentiment", "lumi_events", "lumi_trades", "lumi_institutional_brief", "lumi_vendor_report"],
    },
    note: "On the remote server, paid tools return the price and how to pay (x402 at the REST endpoint, or the npm package with your wallet). Stale data is never sold.",
  };
}

const IOU_NAMES: Record<string, string> = { RLUSD: "Ripple USD", USDC: "Circle USDC" };

function orIous(cfg: Config): string {
  return cfg.ious.map((o) => ` or ${o.symbol}`).join("");
}

/** "XRP or RLUSD or USDC on the XRP Ledger, or USDC on Base" */
export function settledIn(cfg: Config): string {
  return `XRP${orIous(cfg)} on the XRP Ledger${cfg.evm ? `, or USDC on ${cfg.evm.networkName}` : ""}`;
}

/** Every payment network, in `accepts` order (XRPL first). */
export function paymentNetworks(cfg: Config) {
  const out: Record<string, unknown>[] = [
    {
      network: cfg.network,
      name: cfg.networkName === "mainnet" ? "XRP Ledger" : `XRP Ledger ${cfg.networkName}`,
      scheme: "exact",
      assets: ["XRP", ...cfg.ious.map((o) => o.symbol)],
      accepts_index: cfg.ious.length ? `0-${cfg.ious.length}` : "0",
      pay_to: cfg.payTo,
      facilitator: cfg.facilitatorUrl,
      source_tag: cfg.sourceTag,
      payload: "presigned XRPL Payment blob (x402-xrpl)",
    },
  ];
  if (cfg.evm) {
    out.push({
      network: cfg.evm.network,
      name: cfg.evm.networkName,
      scheme: "exact",
      assets: ["USDC"],
      token: cfg.evm.asset,
      decimals: cfg.evm.decimals,
      accepts_index: String(cfg.ious.length + 1),
      pay_to: cfg.evm.payTo,
      facilitator: cfg.evm.cdp ? cfg.evm.cdp.url : cfg.evm.facilitatorUrl,
      ...(cfg.evm.cdp ? { fallback_facilitator: cfg.evm.facilitatorUrl } : {}),
      payload: "EIP-3009 transferWithAuthorization (gasless for the payer; @x402/evm, @x402/fetch)",
    });
  }
  return out;
}

function assetsInfo(cfg: Config) {
  const out: Record<string, unknown>[] = [{ symbol: "XRP", asset: "XRP", unit: "drops in accepts[].amount", accepts_index: 0 }];

  cfg.ious.forEach((o, i) =>
    out.push({
      symbol: o.symbol,
      name: IOU_NAMES[o.symbol],
      asset: o.currency,
      issuer: o.issuer,
      unit: 'IOU value string in accepts[].amount (e.g. "0.01" = 1 US cent)',
      accepts_index: i + 1,
      note: `Payer needs a ${o.symbol} trust line to ${o.issuer} and a balance.`,
    }),
  );
  if (cfg.evm) {
    out.push({
      symbol: "USDC",
      name: `Circle USDC on ${cfg.evm.networkName}`,
      network: cfg.evm.network,
      asset: cfg.evm.asset,
      unit: 'atomic units (6 decimals) in accepts[].amount (e.g. "10000" = 0.01 USDC)',
      accepts_index: cfg.ious.length + 1,
      pay_to: cfg.evm.payTo,
      note: "EIP-3009 signature only; the facilitator pays gas. Payer needs USDC on Base, no ETH.",
    });
  }
  return out;
}

function iouNote(cfg: Config): string {
  if (!cfg.ious.length) return "";
  const lines = cfg.ious
    .map(
      (o, i) =>
        `   \`accepts[${i + 1}]\` is the same quote in **${o.symbol}** (${IOU_NAMES[o.symbol]}): \`{ asset: "${o.currency}", amount: "<value, e.g. 0.01>", extra: { issuer: "${o.issuer}", invoiceId, sourceTag, symbol: "${o.symbol}" } }\`.`,
    )
    .join("\n");
  return `${lines}
   Pick one option and echo it back unchanged as \`accepted\` (all options share one invoice; it can be paid once). To pay in a stablecoin your wallet needs a
   trust line to that issuer and a balance; the Payment's \`Amount\` is \`{ currency, issuer, value }\` and \`SendMax\` equals \`Amount\` (no conversion).
`;
}

export function skillMd(cfg: Config, base: string, coins: CoinRef[]): string {
  const rows = priceTable(cfg)
    .map((p) => `| \`${p.method} ${p.path}\` | ${p.price_xrp} XRP (${p.price_drops} drops)${p.prices.slice(1).map((x) => ` or ${x.amount} ${x.asset}${"chain" in x ? ` on ${x.chain}` : ""}`).join("")} | ${p.summary} |`)
    .join("\n");
  const net = cfg.network;
  const wsUrl = net === "xrpl:0" ? "wss://xrplcluster.com" : "wss://s.altnet.rippletest.net:51233";
  const rpcUrl = net === "xrpl:0" ? "https://xrplcluster.com/" : "https://s.altnet.rippletest.net:51234/";
  const maxDrops = Math.max(...Object.values(cfg.pricesDrops).map(Number));
  return `---
name: lumi-api
description: Pay-per-call crypto market reads from Lumi Trades (daily market brief, signals, support/resistance levels, paper-trade ideas + track record, BTC + macro backdrop, yen carry-trade watch, Fear & Greed sentiment, events calendar, daily Institutional & Policy Brief) for ${coins.length} coins, paid in ${settledIn(cfg)} via x402. Use when you need a current technical read or trade-idea context for ${coins.map((c) => c.symbol).join(", ")}.
---

# Lumi API (agent guide)

Base URL: ${base}
Network: \`${net}\` (${cfg.networkName}). Assets: XRP${cfg.ious.map((o) => ` or ${o.symbol} (${IOU_NAMES[o.symbol]}, issuer \`${o.issuer}\`, currency \`${o.currency}\`)`).join("")}. Pay to: \`${cfg.payTo}\`.
${cfg.evm ? `Also: \`${cfg.evm.network}\` (${cfg.evm.networkName}). Asset: USDC \`${cfg.evm.asset}\`. Pay to: \`${cfg.evm.payTo}\`. Facilitator: ${cfg.evm.cdp ? `${cfg.evm.cdp.url} (Coinbase CDP; fallback ${cfg.evm.facilitatorUrl})` : cfg.evm.facilitatorUrl}.
` : ""}Protocol: [x402](https://xrpl.org/docs/agents/agentic-payments-x402) v2, \`exact\` scheme (one presigned XRPL Payment per call${cfg.evm ? ", or one EIP-3009 USDC authorization on Base" : ""}).
No API key, no account, no sign-up.
A2A agent card: ${base}/.well-known/agent-card.json. MCP: ${base}/mcp.

## What you can buy

| Endpoint | Price | What you get |
|---|---|---|
${rows}

\`{coin}\` is a ticker or CoinGecko id, case-insensitive: ${coins.map((c) => c.symbol).join(", ")}.
Unknown coins return 404 **before** any payment is requested.

Which one to call:
- Need "what's going on in crypto today" in one call? \`GET /v1/brief\` (add \`?format=md\` for ready-to-post markdown).
- Macro risk from Japan / the yen carry trade? \`GET /v1/macro/yen\`.
- Mood/positioning only? \`GET /v1/sentiment\`. What's scheduled? \`GET /v1/events\`.
- What are central banks, regulators and big banks doing, and what does it mean for XRP, XLM, XDC, QNT, AXL, HBAR? \`GET /v1/institutional\`
  (daily, sourced; each link labelled \`confirmed\`, \`indirect_alignment\` (Lumi's analysis) or \`context\`; \`?format=md\` for markdown).
- Is Lumi any good? \`GET /v1/trades\` (every paper trade, wins and losses). Current ideas only? \`GET /v1/slate\`.
- One coin? \`GET /v1/signal/{coin}\` + \`GET /v1/levels/{coin}\`.
- Checking an x402 vendor before you pay it? \`GET /v1/trust/vendors/{id}\` is the free summary; \`GET /v1/trust/vendors/{id}/report\` ($0.02)
  is the full observation history (every quote check and paid test-buy with tx hashes, latency stats and trend, uptime %, verified reports, replies).
  Unknown vendor: 404; no observation in the last 48 h: 503. Both before any 402, never charged.

Fields that are not available at request time are omitted, never filled with guesses.

**You only pay when you get data.** Before a price is even quoted, the API loads and checks every input the endpoint needs
(present, non-empty, recently refreshed). If anything is missing, empty or stale you get \`503\` with \`"note": "Not charged."\`
and **no 402 quote**, so no payment can be signed or settled. The response body is built *before* the payment is settled and is
served right after a validated \`tesSUCCESS\`: a settled payment always returns the data you paid for.

Free: \`GET /\`, \`GET /health\`, \`GET /skill.md\`, \`GET /v1/coins\`, \`GET /v1/trust/vendors\`, \`GET /v1/trust/vendors/{id}\`, \`GET /v1/trust/methodology\`, \`GET /.well-known/x402\`, \`GET /.well-known/agent-card.json\`, \`GET /openapi.json\`, \`POST /mcp\`, \`POST /a2a\`.

Every paid response is JSON with \`timestamp\`, \`source: "${SOURCE}"\`, a \`payment\` block (network, tx hash, explorer link) and a \`disclaimer\`.
Data is refreshed from lumitrades.io roughly every minute; analysis text is updated a few times a day; the Institutional & Policy Brief once a day (not sold if older than 36 h).

## How payment works

1. \`GET ${base}/v1/signal/XRP\` with no payment -> **HTTP 402**. The body (and the base64 \`PAYMENT-REQUIRED\` header) is an x402 v2 \`PaymentRequired\`:
   \`accepts[0] = { scheme: "exact", network: "${net}", asset: "XRP", amount: "<drops>", payTo: "${cfg.payTo}", maxTimeoutSeconds: ${cfg.invoiceTtlSeconds}, extra: { invoiceId, sourceTag: ${cfg.sourceTag} } }\`
${iouNote(cfg)}2. Sign (do not submit) an XRPL \`Payment\` for exactly \`amount\` drops to \`payTo\`, with \`SourceTag\`, a \`LastLedgerSequence\`,
   and the invoice bound via a Memo (\`MemoData = hex(utf8(invoiceId))\`) and/or \`InvoiceID = SHA-256(invoiceId)\`.
3. Retry the same request with header \`PAYMENT-SIGNATURE: base64(JSON{ x402Version: 2, accepted: <accepts[0]>, payload: { signedTxBlob, invoiceId } })\`.
4. The server has the facilitator (${cfg.facilitatorUrl}) verify and submit your payment. On a validated \`tesSUCCESS\` you get **200**
   with the data and a \`PAYMENT-RESPONSE\` header: base64 \`{ success, transaction, network, payer }\`.

Quotes expire after ${cfg.invoiceTtlSeconds}s and each invoice can be paid once. If you get 402 again, read \`error\` and pay the fresh quote.
503 with \`retryable: true, settlementAttempted: false\` is safe to retry with the same header. 409 \`settlement_status_unknown\`: look up your tx on the ledger before paying again.

The x402-xrpl SDKs (T54, the reference XRPL implementation) do all of this for you.
${cfg.evm ? `
### Paying with USDC on ${cfg.evm.networkName} instead

The same 402 also lists \`accepts[${cfg.ious.length + 1}]\` = \`{ scheme: "exact", network: "${cfg.evm.network}", asset: "${cfg.evm.asset}", amount: "<atomic USDC, 6 decimals: 10000 = 0.01>", payTo: "${cfg.evm.payTo}", maxTimeoutSeconds: ${cfg.invoiceTtlSeconds}, extra: { name: "${cfg.evm.eip712.name}", version: "${cfg.evm.eip712.version}", invoiceId, symbol: "USDC", decimals: 6 } }\`.
Sign an EIP-3009 \`transferWithAuthorization\` for exactly \`amount\` to \`payTo\` and retry with \`PAYMENT-SIGNATURE: base64(JSON{ x402Version: 2, accepted: <that entry, unchanged>, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } })\`.
Lumi's facilitator (${cfg.evm.cdp ? `Coinbase CDP, fallback ${cfg.evm.facilitatorUrl}` : cfg.evm.facilitatorUrl}) verifies it and submits it on ${cfg.evm.networkName}, paying the gas: your wallet needs USDC only, no ETH. Same rules: one invoice, one payment, never charged when data is stale.
The official x402 client packages (\`@x402/fetch\` + \`@x402/evm\`) do this for you and skip the XRPL options automatically.
` : ""}

## Example: TypeScript / Node (npm \`x402-xrpl\`)

\`\`\`ts
import { Wallet } from "xrpl";
import { x402Fetch, decodePaymentResponseHeader } from "x402-xrpl";

const fetchPaid = x402Fetch({
  wallet: Wallet.fromSeed(process.env.XRPL_SEED!),   // your agent's wallet
  network: "${net}",
  wsUrl: "${wsUrl}",
  maxValue: "${maxDrops}",                            // spend cap per call, in drops
});

const res = await fetchPaid("${base}/v1/signal/XRP");
console.log(res.status, await res.json());
const receipt = res.headers.get("PAYMENT-RESPONSE");
if (receipt) console.log(decodePaymentResponseHeader(receipt)); // { success, transaction, ... }
\`\`\`
${cfg.ious.length ? `
Pay in a stablecoin instead (wallet must hold it on a trust line to the issuer):

\`\`\`ts
const STABLE = { ${cfg.ious.map((o) => `${o.symbol}: { currency: "${o.currency}", issuer: "${o.issuer}" }`).join(", ")} };
const want = STABLE.${cfg.ious[0].symbol};
const fetchStable = x402Fetch({
  wallet: Wallet.fromSeed(process.env.XRPL_SEED!),
  network: "${net}",
  wsUrl: "${wsUrl}",
  // pick the stablecoin option and cap it at 0.05 per call
  paymentRequirementsSelector: (accepts) => {
    const r = accepts.find((a: any) => a.asset === want.currency && a.extra?.issuer === want.issuer);
    if (!r || Number(r.amount) > 0.05) throw new Error("no acceptable stablecoin quote");
    return r;
  },
});
\`\`\`
Note: the SDK's numeric \`maxValue\` compares raw \`amount\` strings across assets (drops for XRP, a decimal value for stablecoins), so use a selector like the one above when paying in a stablecoin.
` : ""}

${cfg.evm ? `## Example: USDC on ${cfg.evm.networkName} (npm \`@x402/fetch\`, \`@x402/evm\`, \`viem\`)

\`\`\`ts
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as \`0x\${string}\`) });
const fetchPaid = wrapFetchWithPayment(fetch, client);   // picks the ${cfg.evm.network} USDC option

const res = await fetchPaid("${base}/v1/brief");
console.log(res.status, await res.json());
console.log(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!)); // { success, transaction, network, payer }
\`\`\`

` : ""}## Example: Python (PyPI \`x402-xrpl\`)

\`\`\`python
import os
from xrpl.wallet import Wallet
from x402_xrpl.clients import x402_requests, decode_payment_response

session = x402_requests(
    Wallet.from_seed(os.environ["XRPL_SEED"]),
    rpc_url="${rpcUrl}",
    network_filter="${net}",
    scheme_filter="exact",
)
r = session.get("${base}/v1/market", timeout=180)
print(r.status_code, r.json()["macro"]["yen_note"])
print(decode_payment_response(r.headers["PAYMENT-RESPONSE"]))
\`\`\`

## MCP

- **Remote MCP server:** \`${base}/mcp\` (Streamable HTTP, stateless; protocol 2026-07-28 and 2025-03-26 .. 2025-11-25).
  Add it as a remote MCP connector URL. Free tools: \`lumi_catalog\`, \`lumi_coins\`, \`lumi_quote\`, \`lumi_vendor_scores\`. Paid tools (\`lumi_brief\`,
  \`lumi_signal\`, \`lumi_levels\`, \`lumi_slate\`, \`lumi_market\`, \`lumi_macro_yen\`, \`lumi_sentiment\`, \`lumi_events\`, \`lumi_trades\`, \`lumi_institutional_brief\`, \`lumi_vendor_report\`)
  return the price and how to pay, since a remote connector has no wallet.
- **Local MCP server that pays for you:** \`npx -y lumi-trades-mcp\` with \`XRPL_SEED\` set (npm \`lumi-trades-mcp\`, MCP Registry
  \`io.github.cypher-osiris/lumi-trades-mcp\`). Same tools; each paid call is an x402 payment from your wallet within per-call caps and a session budget.

## A2A

- **Agent card:** \`${base}/.well-known/agent-card.json\` (alias \`/.well-known/agent.json\`), A2A protocol 1.0 with 0.3 compatibility fields.
- **JSON-RPC endpoint:** \`POST ${base}/a2a\` with \`SendMessage\` (A2A 1.0) or \`message/send\` (0.3). Send text such as "list coins", "catalog" or
  "signal XRP", or a data part \`{ "skill": "signal", "coin": "XRP" }\`. Free skills (\`catalog\`, \`coins\`, \`quote\`, \`vendor_trust\`) answer inline. Paid skills answer with
  the live x402 terms (every network option) and the REST URL to pay at; nothing is charged over A2A.

## x402 vendor observations (free)

Lumi publishes its automated observations of other x402 sellers on the XRP Ledger: an unpaid 402-quote check of each listed endpoint every 30 minutes,
and one small paid test-buy per vendor per day from Lumi's own wallet, each with the amount, ledger tx hash, HTTP status and whether the response contained data.
Scores are observations with sample sizes, not ratings; few samples are marked low confidence; vendors are listed in allowlist order, not ranked.

- \`GET ${base}/v1/trust/vendors\`, \`GET ${base}/v1/trust/vendors/{id}\`, method: \`GET ${base}/v1/trust/methodology\`. MCP: \`lumi_vendor_scores\`. A2A: \`vendor_trust\`.
- **Paid detailed report ($0.02 per call, x402 on every rail):** \`GET ${base}/v1/trust/vendors/{id}/report\`: full observation history (every free quote
  check over 90 days, every paid test-buy with tx hash and delivered yes/no), latency min/p50/p90/p95/max and 7-day trend, uptime % for 24h/7d/30d/90d and a
  daily series, quoted-price history, verified agent reports, vendor replies, sample sizes and confidence labels. Not sold (503, not charged) if Lumi has no
  observation of the vendor in the last 48 h. MCP: \`lumi_vendor_report\`. A2A: \`vendor_report\`.
- **Report a call you paid for:** \`POST ${base}/v1/reports\` with \`{vendor_id, network, tx_hash, reporter, outcome, signature}\`, where \`signature\` signs
  \`lumi-report:<network>:<tx_hash>\` with the paying key. Only reports with an on-ledger payment and a valid signature are shown or scored.
- **Private tips:** \`POST ${base}/v1/tips\` \`{text, coins?, source_urls?}\`. Stored privately; never published or returned.
- **Vendors can reply:** sign \`lumi-reply:<vendor_id>:<sha256 of text>\` with a listed pay-to key and \`POST ${base}/v1/trust/replies\`, or email hello@lumitrades.io.

## Rules of use

- ${DISCLAIMER}
- Trade ideas are a public paper-trading slate. Do not present them as personalised advice.
- Cite "Lumi Trades (lumitrades.io)" when you surface this data to people.
`;
}
