/** Free, human- and agent-facing documents: index, skill.md, discovery manifests, OpenAPI. */

import type { Config } from "./config";
import { EXPLORERS, dropsToXrp } from "./config";
import { PAID_ENDPOINTS, priceTable } from "./catalog";
import { DISCLAIMER, SOURCE, type CoinRef } from "./views";

export const VERSION = "0.1.0";

export function indexDoc(cfg: Config, base: string, coins: CoinRef[]) {
  return {
    name: "Lumi API",
    version: VERSION,
    description:
      "Pay-per-call crypto market reads from Lumi Trades (lumitrades.io) for AI agents. " +
      "No API keys or accounts: each paid call is settled in XRP on the XRP Ledger via the x402 protocol (HTTP 402, exact scheme).",
    human_summary:
      "Lumi publishes indicator signals, support/resistance levels, a paper-trade slate and a BTC/macro backdrop for 13 coins. " +
      "Agents call an endpoint, receive HTTP 402 with a price in XRP, sign a small XRP Payment, retry, and get JSON back.",
    source: SOURCE,
    payment: {
      protocol: "x402",
      x402Version: 2,
      scheme: "exact",
      network: cfg.network,
      network_name: cfg.networkName,
      asset: "XRP",
      pay_to: cfg.payTo,
      facilitator: cfg.facilitatorUrl,
      source_tag: cfg.sourceTag,
      headers: { challenge: "PAYMENT-REQUIRED", payment: "PAYMENT-SIGNATURE", receipt: "PAYMENT-RESPONSE" },
      explorer: EXPLORERS[cfg.network],
    },
    free_endpoints: [
      { method: "GET", path: "/", summary: "This index" },
      { method: "GET", path: "/health", summary: "Liveness + config summary" },
      { method: "GET", path: "/skill.md", summary: "Agent guide: what is offered, prices, how to pay, example code" },
      { method: "GET", path: "/.well-known/x402", summary: "x402 discovery manifest" },
      { method: "GET", path: "/openapi.json", summary: "OpenAPI 3.1 description with x-payment-info" },
      { method: "GET", path: "/v1/coins", summary: "Supported coins" },
    ],
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
    description: "Pay-per-call crypto market reads (signals, levels, paper-trade slate, macro) from lumitrades.io, settled in XRP on the XRP Ledger.",
    resources: PAID_ENDPOINTS.map((e) => ({
      url: `${base}${e.example}`,
      template: `${base}${e.template}`,
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
      ],
    })),
    facilitators: [cfg.facilitatorUrl],
    openapi: `${base}/openapi.json`,
    docs: `${base}/skill.md`,
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
  };
  const paths: Record<string, unknown> = {
    "/v1/coins": { get: { summary: "List supported coins (free)", responses: { "200": { description: "OK" } } } },
    "/health": { get: { summary: "Health (free)", responses: { "200": { description: "OK" } } } },
  };
  for (const e of PAID_ENDPOINTS) {
    paths[e.template] = {
      get: {
        summary: e.summary,
        parameters: e.template.includes("{coin}") ? [coinParam] : [],
        "x-payment-info": {
          protocols: ["x402"],
          price: { mode: "fixed", currency: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]) },
          scheme: "exact",
          network: cfg.network,
          asset: "XRP",
          amount_drops: cfg.pricesDrops[e.route],
          payTo: cfg.payTo,
        },
        responses: {
          "200": { description: "Paid data (JSON). Settlement receipt in the PAYMENT-RESPONSE header." },
          "402": { description: "Payment required. x402 v2 PaymentRequired in the body and the PAYMENT-REQUIRED header." },
          "404": { description: "Unknown coin (never charged)." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Lumi API", version: VERSION, description: "Pay-per-call crypto market reads from lumitrades.io, paid in XRP via x402." },
    servers: [{ url: base }],
    paths,
  };
}

export function skillMd(cfg: Config, base: string, coins: CoinRef[]): string {
  const rows = priceTable(cfg)
    .map((p) => `| \`${p.method} ${p.path}\` | ${p.price_xrp} XRP (${p.price_drops} drops) | ${p.summary} |`)
    .join("\n");
  const net = cfg.network;
  const wsUrl = net === "xrpl:0" ? "wss://xrplcluster.com" : "wss://s.altnet.rippletest.net:51233";
  const rpcUrl = net === "xrpl:0" ? "https://xrplcluster.com/" : "https://s.altnet.rippletest.net:51234/";
  const maxDrops = Math.max(...Object.values(cfg.pricesDrops).map(Number));
  return `---
name: lumi-api
description: Pay-per-call crypto market reads from Lumi Trades (signals, support/resistance levels, paper-trade ideas, BTC + macro backdrop) for ${coins.length} coins, paid in XRP on the XRP Ledger via x402. Use when you need a current technical read or trade-idea context for ${coins.map((c) => c.symbol).join(", ")}.
---

# Lumi API (agent guide)

Base URL: ${base}
Network: \`${net}\` (${cfg.networkName}). Asset: XRP. Pay to: \`${cfg.payTo}\`.
Protocol: [x402](https://xrpl.org/docs/agents/agentic-payments-x402) v2, \`exact\` scheme (one presigned XRPL Payment per call).
No API key, no account, no sign-up.

## What you can buy

| Endpoint | Price | What you get |
|---|---|---|
${rows}

\`{coin}\` is a ticker or CoinGecko id, case-insensitive: ${coins.map((c) => c.symbol).join(", ")}.
Unknown coins return 404 **before** any payment is requested.

Free: \`GET /\`, \`GET /health\`, \`GET /skill.md\`, \`GET /v1/coins\`, \`GET /.well-known/x402\`, \`GET /openapi.json\`.

Every paid response is JSON with \`timestamp\`, \`source: "${SOURCE}"\`, a \`payment\` block (tx hash, explorer link) and a \`disclaimer\`.
Data is refreshed from lumitrades.io roughly every minute; analysis text is updated a few times a day.

## How payment works

1. \`GET ${base}/v1/signal/XRP\` with no payment -> **HTTP 402**. The body (and the base64 \`PAYMENT-REQUIRED\` header) is an x402 v2 \`PaymentRequired\`:
   \`accepts[0] = { scheme: "exact", network: "${net}", asset: "XRP", amount: "<drops>", payTo: "${cfg.payTo}", maxTimeoutSeconds: ${cfg.invoiceTtlSeconds}, extra: { invoiceId, sourceTag: ${cfg.sourceTag} } }\`
2. Sign (do not submit) an XRPL \`Payment\` for exactly \`amount\` drops to \`payTo\`, with \`SourceTag\`, a \`LastLedgerSequence\`,
   and the invoice bound via a Memo (\`MemoData = hex(utf8(invoiceId))\`) and/or \`InvoiceID = SHA-256(invoiceId)\`.
3. Retry the same request with header \`PAYMENT-SIGNATURE: base64(JSON{ x402Version: 2, accepted: <accepts[0]>, payload: { signedTxBlob, invoiceId } })\`.
4. The server has the facilitator (${cfg.facilitatorUrl}) verify and submit your payment. On a validated \`tesSUCCESS\` you get **200**
   with the data and a \`PAYMENT-RESPONSE\` header: base64 \`{ success, transaction, network, payer }\`.

Quotes expire after ${cfg.invoiceTtlSeconds}s and each invoice can be paid once. If you get 402 again, read \`error\` and pay the fresh quote.
503 with \`retryable: true, settlementAttempted: false\` is safe to retry with the same header. 409 \`settlement_status_unknown\`: look up your tx on the ledger before paying again.

The x402-xrpl SDKs (T54, the reference XRPL implementation) do all of this for you.

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

## Example: Python (PyPI \`x402-xrpl\`)

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

## Rules of use

- ${DISCLAIMER}
- Trade ideas are a public paper-trading slate. Do not present them as personalised advice.
- Cite "Lumi Trades (lumitrades.io)" when you surface this data to people.
`;
}
