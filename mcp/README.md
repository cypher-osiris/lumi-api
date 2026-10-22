# lumi-trades-mcp

MCP server (stdio) for **[Lumi Trades](https://lumitrades.io)**: lets Claude Desktop, Cursor, Claude Code, Cline, Windsurf and any other
MCP client call the [Lumi API](https://api.lumitrades.io/skill.md) and **pay per call via x402 on the XRP Ledger with your own wallet**.
No API key, no account: each paid tool call is one small XRPL payment (XRP, RLUSD or USDC), signed locally on your machine.

> Analytics and education only. Not financial advice. Lumi's trade ideas are public paper trades.

## Tools

| Tool | Paid? | Price (XRP / stable) | What you get |
|---|---|---|---|
| `lumi_catalog` | free | – | Endpoints, live prices, this server's wallet + spend caps |
| `lumi_coins` | free | – | The 13 coins covered (XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI) |
| `lumi_quote` | free | – | The x402 quote for any paid path, without paying |
| `lumi_brief` | paid | 0.02 / 0.03 | Today's market brief (BTC, CoinMarketCap Fear & Greed, movers, key levels, yen, events, paper trades, news). `format: "md"` for markdown |
| `lumi_signal` | paid | 0.005 / 0.01 | Buy/sell read for one coin (1h/4h/1d + indicators) |
| `lumi_levels` | paid | 0.005 / 0.01 | Support/resistance, 7-day projection, commentary for one coin |
| `lumi_slate` | paid | 0.01 / 0.02 | Current paper-trade ideas |
| `lumi_market` | paid | 0.01 / 0.02 | BTC + macro backdrop and breadth |
| `lumi_macro_yen` | paid | 0.01 / 0.015 | USD/JPY, Nikkei, carry-trade risk around 155, Japan events |
| `lumi_sentiment` | paid | 0.005 / 0.01 | Fear & Greed, funding read, OI, dominance, breadth |
| `lumi_events` | paid | 0.005 / 0.01 | Sourced upcoming macro/crypto events and catalysts |
| `lumi_trades` | paid | 0.01 / 0.02 | Full paper-trade history + honest track record |

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
        "XRPL_SEED": "sEd...your agent wallet seed...",
        "LUMI_PAY_ASSET": "XRP",
        "LUMI_MAX_XRP_PER_CALL": "0.05",
        "LUMI_SESSION_BUDGET": "0.5"
      }
    }
  }
}
```

From a clone instead: `"command": "node", "args": ["/absolute/path/to/lumi-api/mcp/src/index.js"]` (after `npm install` in `mcp/`).
Claude Code: `claude mcp add lumi-trades -e XRPL_SEED=sEd... -- npx -y lumi-trades-mcp`.

Without `XRPL_SEED` the free tools work and paid tools return the price quote instead of paying.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `XRPL_SEED` | – | Seed of **your** XRPL wallet that pays. Kept in memory only; never logged, returned to the model or sent anywhere (payments are signed locally, the API only receives the signed blob). Use a dedicated low-balance agent wallet. |
| `LUMI_PAY_ASSET` | `XRP` | `XRP`, `RLUSD` or `USDC` (stablecoins need a trust line + balance) |
| `LUMI_MAX_XRP_PER_CALL` | `0.05` | Refuse any quote above this (XRP) |
| `LUMI_MAX_USD_PER_CALL` | `0.05` | Refuse any stablecoin quote above this |
| `LUMI_SESSION_BUDGET` | `1` | Max total spend per server process, in the pay asset |
| `XRPL_NETWORK` | `xrpl:0` | `xrpl:0` mainnet, `xrpl:1` testnet |
| `LUMI_API_URL` | `https://api.lumitrades.io` | API base URL |
| `LUMI_EXPECTED_PAY_TO` | Lumi's mainnet wallet `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` (official API on mainnet) | Refuse to pay any other address |
| `XRPL_WS_URL` | `wss://xrplcluster.com` / `wss://testnet.xrpl-labs.com` | Ledger connection used to autofill and sign |

Safety: before signing, the server checks network, scheme, asset, payee, per-call cap and session budget. Anything off and it
does not sign. Every paid result carries the on-ledger transaction hash.

## Tests

```bash
npm test                         # spend-cap / payee / settings unit tests
node scripts-e2e-testnet.mjs     # testnet only: real x402 payments through MCP against a local testnet API (see the file header)
```

Testnet run, Oct 22 2026 (via MCP stdio, x402 on XRPL Testnet, all `tesSUCCESS`): `lumi_sentiment` 9137C1AE…, `lumi_macro_yen`
38DDADD0…, `lumi_events` EBD235D3…, `lumi_trades` 661D8180…, `lumi_brief` (markdown) 16F1BEFA….

## License

MIT
