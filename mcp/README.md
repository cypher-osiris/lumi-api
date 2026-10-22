# lumi-trades-mcp

MCP server (stdio) for **[Lumi Trades](https://lumitrades.io)**: **free x402 vendor trust score lookups**, a **daily crypto market brief**
and **Institutional & Policy Brief**, and **crypto signals** (XRP and 12 more coins) for Claude Desktop, Cursor, Claude Code, Cline, Windsurf
and any other MCP client. Paid tools **pay per call via x402 with your own wallet: USDC on Base (gasless) or XRP / RLUSD / USDC on the XRP Ledger**.
No API key, no account: each paid tool call is one small payment, signed locally on your machine.

> Analytics and education only. Not financial advice. Lumi's trade ideas are public paper trades.

**No install needed to browse:** the same tools are also served remotely at `https://api.lumitrades.io/mcp` (Streamable HTTP),
for clients that take a remote MCP server URL. A remote connector has no wallet, so its paid tools return the price and how to pay;
use this package when you want paid tools to pay automatically from your own wallet.

## Tools

| Tool | Paid? | Price (USD / XRP) | What you get |
|---|---|---|---|
| `lumi_catalog` | free | – | Endpoints, live prices, this server's wallet + spend caps |
| `lumi_samples` | free | `route?` | Truncated, labelled samples of every paid product with USD price and full URL |
| `lumi_coins` | free | – | The 13 coins covered (XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI) |
| `lumi_quote` | free | – | The x402 quote for any paid path, without paying |
| `lumi_vendor_scores` | free | – | Lumi's automated observations of other x402 vendors (402-quote checks, paid test-buys, tx evidence, sample sizes); optional `vendor_id` |
| `lumi_brief` | paid | $0.03 / 0.02 | Today's market brief (BTC, CoinMarketCap Fear & Greed, movers, key levels, yen, events, paper trades, news). `format: "md"` for markdown |
| `lumi_signal` | paid | $0.01 / 0.005 | Buy/sell read for one coin (1h/4h/1d + indicators) |
| `lumi_levels` | paid | $0.01 / 0.005 | Support/resistance, 7-day projection, commentary for one coin |
| `lumi_slate` | paid | $0.02 / 0.01 | Current paper-trade ideas |
| `lumi_market` | paid | $0.02 / 0.01 | BTC + macro backdrop and breadth |
| `lumi_macro_yen` | paid | $0.015 / 0.01 | USD/JPY, Nikkei, carry-trade risk around 155, Japan events |
| `lumi_sentiment` | paid | $0.01 / 0.005 | Fear & Greed, funding read, OI, dominance, breadth |
| `lumi_events` | paid | $0.01 / 0.005 | Sourced upcoming macro/crypto events and catalysts |
| `lumi_trades` | paid | $0.02 / 0.01 | Paper-trade history as a raw list (entry, stop, targets, status, reasoning) |
| `lumi_vendor_report` | paid | $0.02 / 0.015 | Full observation history for one x402 vendor on Lumi's trust list: every quote check (90 days) and paid test-buy with tx hash and delivered yes/no, latency stats and trend, uptime %, verified agent reports, vendor replies, confidence labels. `vendor_id` required |
| `lumi_institutional_brief` | paid | $0.25 / 0.19 | Daily Institutional & Policy Brief: BIS, IMF, US Treasury/regulators, JPMorgan, SBI, Cross River, Securitize, R3 and others mapped to XRP, XLM, XDC, QNT, AXL, HBAR (confirmed vs indirect-alignment links, sourced). `format: "md"` for markdown. Allowed by the default caps (0.30 USD / 0.25 XRP) |

Prices are read live from each 402 quote; the table is for orientation. **You only pay when you get data**: the API refuses to quote
(503, "Not charged.") when its data is missing or stale, so a payment is never settled without data.

## Install

Requires Node 20+. Published on npm as [`lumi-trades-mcp`](https://www.npmjs.com/package/lumi-trades-mcp) and in the
[official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=lumi-trades) as `io.github.cypher-osiris/lumi-trades-mcp`.

```bash
npx -y lumi-trades-mcp
```

### Claude Desktop / Cursor / any MCP client (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "lumi-trades": {
      "command": "npx",
      "args": ["-y", "lumi-trades-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...your Base agent wallet key (holds USDC, no ETH needed)...",
        "LUMI_MAX_USD_PER_CALL": "0.30",
        "LUMI_SESSION_BUDGET": "1"
      }
    }
  }
}
```

Paying on the XRP Ledger instead: set `"XRPL_SEED": "sEd..."` (and optionally `"LUMI_PAY_ASSET": "RLUSD"` or `"USDC"`, default `XRP`) in place of `EVM_PRIVATE_KEY`.

From a clone instead: `"command": "node", "args": ["/absolute/path/to/lumi-api/mcp/src/index.js"]` (after `npm install` in `mcp/`).
Claude Code: `claude mcp add lumi-trades -e EVM_PRIVATE_KEY=0x... -- npx -y lumi-trades-mcp` (or `-e XRPL_SEED=sEd...`).

Without a wallet the free tools work and paid tools return the price quote instead of paying.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `EVM_PRIVATE_KEY` | – | `0x` private key of **your** Base wallet that pays in USDC via an EIP-3009 authorization (gasless: the facilitator pays gas). Kept in memory only; never logged, returned to the model or sent anywhere (only the signature is sent). Use a dedicated low-balance agent wallet. |
| `XRPL_SEED` | – | Seed of **your** XRPL wallet that pays. Kept in memory only; never logged, returned to the model or sent anywhere (payments are signed locally, the API only receives the signed blob). Use a dedicated low-balance agent wallet. |
| `LUMI_PAY_ASSET` | `XRP` if `XRPL_SEED` is set, else `BASE_USDC` | `BASE_USDC` (USDC on Base), or `XRP`, `RLUSD`, `USDC` on the XRP Ledger (XRPL stablecoins need a trust line + balance) |
| `LUMI_MAX_XRP_PER_CALL` | `0.25` | Refuse any XRP quote above this |
| `LUMI_MAX_USD_PER_CALL` | `0.30` | Refuse any stablecoin quote (Base or XRPL) above this. The refusal message names this variable and the value needed |
| `LUMI_SESSION_BUDGET` | `1` | Max total spend per server process, in the pay asset |
| `XRPL_NETWORK` | `xrpl:0` | `xrpl:0` mainnet, `xrpl:1` testnet |
| `LUMI_API_URL` | `https://api.lumitrades.io` | API base URL |
| `LUMI_EXPECTED_PAY_TO` | Lumi's wallets on the official API: `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` (XRPL mainnet), `0x5E617bac19912e6d212CB303ae84655E9E203532` (Base) | Refuse to pay any other address |
| `XRPL_WS_URL` | `wss://xrplcluster.com` / `wss://testnet.xrpl-labs.com` | Ledger connection used to autofill and sign |

Safety: before signing, the server checks network, scheme, asset, payee, per-call cap and session budget. Anything off and it
does not sign. Every paid result carries the on-chain transaction hash.

## Tests

```bash
npm test                         # spend-cap / payee / settings unit tests + a mocked Base USDC payment through @x402/fetch
node scripts-e2e-testnet.mjs     # testnet only: real x402 payments through MCP against a local testnet API (see the file header)
```

Testnet run, Oct 22 2026 (via MCP stdio, x402 on XRPL Testnet, all `tesSUCCESS`): `lumi_sentiment` 9137C1AE…, `lumi_macro_yen`
38DDADD0…, `lumi_events` EBD235D3…, `lumi_trades` 661D8180…, `lumi_brief` (markdown) 16F1BEFA….

## License

MIT
