# Lumi API

**Pay-per-call crypto market reads for AI agents, settled in XRP, RLUSD or USDC on the XRP Ledger via [x402](https://xrpl.org/docs/agents/agentic-payments-x402).**

Lumi Trades ([lumitrades.io](https://lumitrades.io)) publishes indicator signals, support/resistance levels, a public paper-trade slate and track record, a BTC/macro backdrop, a daily market brief, a yen carry-trade watch, a sentiment snapshot and an events calendar for 13 coins. Lumi API puts those reads behind HTTP 402. An agent calls an endpoint, gets a price in XRP, signs one small XRP `Payment`, retries, and receives JSON. There are no API keys, accounts or invoices to reconcile. The payment *is* the authentication, and every call leaves an auditable on-ledger record.

> Analytics and education only. Not financial advice. Trade ideas are paper trades.

---

## Endpoints and pricing

| | Endpoint | Price | Returns |
|---|---|---|---|
| free | `GET /` | – | JSON index: description, payment config, endpoint list, prices |
| free | `GET /health` | – | Liveness, network, receiving address |
| free | `GET /skill.md` (also `/llms.txt`) | – | Agent guide: what's offered, prices, how to pay, example code |
| free | `GET /.well-known/x402` | – | x402 discovery manifest ([draft-hawkins-x402-dns-discovery](https://datatracker.ietf.org/doc/draft-hawkins-x402-dns-discovery/) shape) |
| free | `GET /openapi.json` | – | OpenAPI 3.1 with `x-payment-info` per paid route (x402scan-style discovery) |
| free | `GET /v1/coins` | – | Supported coins |
| **paid** | `GET /v1/signal/{coin}` | **0.005 XRP** or **0.01 RLUSD / USDC** | Buy/sell label + score, 1h/4h/1d labels, indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume) |
| **paid** | `GET /v1/levels/{coin}` | **0.005 XRP** or **0.01 RLUSD / USDC** | Support/resistance, bias, 7-day bull/base/bear projection, commentary, catalysts, sources |
| **paid** | `GET /v1/slate` | **0.01 XRP** or **0.02 RLUSD / USDC** | Active paper-trade ideas (entry/zone, stop, targets, leverage, conviction, status), "no setup" notes, track record |
| **paid** | `GET /v1/market` | **0.01 XRP** or **0.02 RLUSD / USDC** | BTC backdrop (levels, projection, signal), macro (yen/USDJPY note, total cap, dominance, fear & greed, BTC perp funding/OI), breadth |
| **paid** | `GET /v1/brief` | **0.02 XRP** or **0.03 RLUSD / USDC** | Today's market brief (what the newsletter and Shorts say): BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, top/bottom movers, key levels for all 13 coins, yen watch, events in the next 48h, paper trades + record, sourced news. JSON with a `markdown` field; `?format=md` returns `text/markdown` |
| **paid** | `GET /v1/macro/yen` | **0.01 XRP** or **0.015 RLUSD / USDC** | USD/JPY + Nikkei 225 (price, 1d/5d change, ranges), rule-based carry-trade risk (`low`/`watch`/`elevated`) around the 155 line with reasons, Lumi's yen note, Japan events (CPI, BOJ), sources |
| **paid** | `GET /v1/sentiment` | **0.005 XRP** or **0.01 RLUSD / USDC** | CoinMarketCap Fear & Greed (value, band, change), BTC perp funding + plain-English read + OI (OKX), total cap/volume/dominance, breadth and signal-label counts |
| **paid** | `GET /v1/events` | **0.005 XRP** or **0.01 RLUSD / USDC** | Sourced upcoming macro/crypto events: timed releases (UTC + US Central, why it matters) and dated per-coin catalysts (Fed, BOJ, CPI, upgrades, conferences) |
| **paid** | `GET /v1/trades` | **0.01 XRP** or **0.02 RLUSD / USDC** | Every paper trade ever posted (wins, losses, cancelled) + computed track record: win rate, sum/avg P&L, best/worst, by coin, by direction, equity curve, open unrealized P&L |

Pricing rationale (Oct 2026, XRP ≈ $1.33): single data feeds on the XRPL AI Hub sell for 0.001-0.012 RLUSD (AskSurf, Heurist Mesh, KR Crypto) and composite reads for ~0.02-0.025 (Strale Fear & Greed via Monid, invinoveritas). Lumi's single feeds sit at 0.01 and the multi-source brief at 0.03.

### You only pay when you get data

Other x402 vendors have taken payment and then returned an upstream error or an empty body. Lumi API is built so that cannot happen:

1. Every input file an endpoint needs is fetched and **validated before any 402 quote is issued**: present, non-empty, and fresh (market data ≤ 12 h old, `DATA_MAX_AGE_HOURS`; hand-written analysis/events ≤ 48 h; FX/Nikkei quotes ≤ 4 days).
2. The response body is **built before settlement** and must carry real content (e.g. a Fear & Greed value for `/v1/sentiment`, a USD/JPY or Nikkei quote for `/v1/macro/yen`).
3. If anything fails, the answer is `503` `{ "error": "data_stale" | "data_unavailable", "note": "Not charged." }` with **no** `PAYMENT-REQUIRED` header. A payment header sent anyway is ignored (the facilitator is never called), even for a quote issued earlier while the data was fresh.
4. Settlement happens only after these checks; the prepared body is returned immediately after a validated `tesSUCCESS`.

Fields that are unavailable are omitted, never guessed. Tests: `test/products.test.ts` ("you only pay when you get data").

`{coin}`: `XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI`. Tickers or CoinGecko ids work, case-insensitive.
Prices are configurable (`PRICE_*_XRP`, `PRICE_*_RLUSD`, `PRICE_*_USDC` in `wrangler.toml`).

### Accepted assets

Every 402 offers the same quote in three assets, all sharing one invoice id (one payment per invoice):

| `accepts[]` | Asset | `asset` field | Issuer (`extra.issuer`) | `amount` unit |
|---|---|---|---|---|
| 0 | XRP | `XRP` | – | drops |
| 1 | RLUSD (Ripple USD) | `524C555344000000000000000000000000000000` | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` ([docs.ripple.com](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)) | IOU value, e.g. `"0.01"` |
| 2 | USDC (Circle) | `5553444300000000000000000000000000000000` | `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` ([developers.circle.com](https://developers.circle.com/stablecoins/usdc-contract-addresses)) | IOU value, e.g. `"0.01"` |

XRP stays first, so clients that take `accepts[0]` keep paying in XRP. Stablecoin prices are fixed in USD cents. At XRP ≈ $1.33 (Oct 22 2026), 0.01 USD ≈ 0.0075 XRP and 0.02 USD ≈ 0.015 XRP, so the XRP prices are slightly cheaper. Payers need a trust line to the issuer and a balance. The Payment is same-asset (`SendMax` = `Amount`, no path or conversion). Turn off either stablecoin with `ACCEPT_RLUSD=false` / `ACCEPT_USDC=false`. Testnet uses the official testnet issuers (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`, `rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt`), and `RLUSD_ISSUER` / `USDC_ISSUER` override them.

To pay in a stablecoin with `x402Fetch`, pass a `paymentRequirementsSelector` that picks the option by `asset` and `extra.issuer`. The SDK's numeric `maxValue` compares raw `amount` strings across assets, so it is not a meaningful cap for IOUs. See `/skill.md`.

Every paid response includes `timestamp`, `source: "lumitrades.io"`, a `payment` block (tx hash, payer, explorer link) and a `disclaimer`.

**You are never charged for a failed request.** Unknown coins return 404 and upstream outages return 503 *before* any payment is requested. Data is only served after a validated `tesSUCCESS` settlement.

## How agents pay (x402 v2, `exact` scheme on XRPL)

```
Agent                          Lumi API (Worker)                 T54 facilitator         XRP Ledger
  | GET /v1/signal/XRP              |                                  |                      |
  |-------------------------------->|                                  |                      |
  | 402 + PAYMENT-REQUIRED          |  (stateless HMAC invoice id)     |                      |
  |<--------------------------------|                                  |                      |
  | sign Payment(20000 drops,       |                                  |                      |
  |  SourceTag, Memo=invoiceId,     |                                  |                      |
  |  InvoiceID=sha256(invoiceId))   |                                  |                      |
  | GET + PAYMENT-SIGNATURE         |                                  |                      |
  |-------------------------------->| check invoice HMAC/expiry/route  |                      |
  |                                 | POST /verify ------------------->|                      |
  |                                 | claim invoice (Durable Object)   |                      |
  |                                 | POST /settle ------------------->| submit blob -------->|
  |                                 |<---------------- tesSUCCESS -----|<---- validated ------|
  | 200 JSON + PAYMENT-RESPONSE     |                                  |                      |
  |<--------------------------------|                                  |                      |
```

1. **Challenge.** An unpaid request gets `402` with an x402 v2 `PaymentRequired` in the body and in the base64 `PAYMENT-REQUIRED` header:
   ```json
   { "scheme": "exact", "network": "xrpl:0", "asset": "XRP", "amount": "20000",
     "payTo": "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM", "maxTimeoutSeconds": 300,
     "extra": { "invoiceId": "lumi1.signal:XRP.<exp>.<nonce>.<mac>", "sourceTag": 804681468 } }
   ```
2. **Pay.** The agent signs (but does not submit) an XRPL `Payment` for exactly `amount` drops to `payTo`, bound to the invoice (Memo + `InvoiceID`), and retries with `PAYMENT-SIGNATURE`.
3. **Settle.** Lumi API checks the invoice, then has the facilitator verify and submit the blob. On a validated `tesSUCCESS` it returns the data and a `PAYMENT-RESPONSE` receipt `{ success, transaction, network, payer }`.

Agents don't have to implement this by hand. The reference XRPL SDKs (`x402-xrpl` on npm and PyPI, maintained by T54) handle it end to end:

```ts
import { Wallet } from "xrpl";
import { x402Fetch } from "x402-xrpl";

const fetchPaid = x402Fetch({ wallet: Wallet.fromSeed(process.env.XRPL_SEED!), network: "xrpl:0", maxValue: "100000" });
const res = await fetchPaid("https://api.lumitrades.io/v1/signal/XRP");
console.log(await res.json());
```

```python
from xrpl.wallet import Wallet
from x402_xrpl.clients import x402_requests
s = x402_requests(Wallet.from_seed(SEED), rpc_url="https://xrplcluster.com/", network_filter="xrpl:0", scheme_filter="exact")
print(s.get("https://api.lumitrades.io/v1/market", timeout=180).json())
```

See `examples/agent-client.ts`, `examples/agent_client.py` and the live `/skill.md`.

### Error semantics (same as the reference middleware)

| Status | Meaning | Agent action |
|---|---|---|
| 402 + `error` | No/invalid/expired/used invoice, or the facilitator rejected the payment | Pay the fresh quote in the body |
| 503 `retryable: true, phase: verify, settlementAttempted: false` | Facilitator or guard unavailable before any money moved | Retry the same header after `Retry-After` |
| 409 `settlement_status_unknown` | Settlement may have happened | Look up your tx on the ledger before paying again |
| 404 / 503 with `"note": "Not charged."` | Bad coin / upstream data down | Fix the request or retry later |

## Design notes

- **Runs on Cloudflare Workers** (`src/index.ts`) and on **plain Node** (`src/node.ts`) from the same `createApp()` (`src/app.ts`). The Worker bundle has no dependencies and is about 13 KiB gzipped.
- **Wire-compatible with the XRPL reference implementation.** `src/x402.ts` mirrors T54's FastAPI/Express `require_payment` middleware (x402 v2 headers, `/verify` then `/settle`, typed 503/409 errors). The official npm and PyPI buyer SDKs work against it unchanged. Both were exercised on testnet.
- **Stateless invoices.** Workers isolates share no memory, so the reference SDK's in-memory invoice store can't be used. Invoice ids are HMAC tokens (`INVOICE_SECRET`) that bind route, amount, network, `payTo` and expiry. Any isolate can validate them, and a quote for `/v1/signal/XRP` can't be redeemed on `/v1/slate`.
- **One-time redemption via a Durable Object** (`src/invoice-guard.ts`). This is required. On testnet, the T54 facilitator returns `success: true` again when an already-settled blob is resubmitted, because XRPL submission is idempotent on the tx hash. `npm run probe:replay` reproduces this. Without a resource-server guard, one payment could be replayed for unlimited data. The guard atomically claims each invoice id before `/settle`. It is sharded 16 ways and expires entries with alarms. SQLite-backed DOs are on the Workers Free plan.
- **Privacy filter** (`src/sanitize.ts`). Every field is whitelisted per endpoint (`src/views.ts`). Free text is then filtered sentence by sentence to drop anything mentioning a configured private name (`PRIVATE_NAMES` secret) or personal holdings/positions, and sensitive keys are dropped recursively. Tests inject canaries to prove it.
- **Short cache.** Upstream `lumitrades.io/data/*.json` is cached for 60s per isolate (`DATA_TTL_SECONDS`), with up to 15 minutes of stale fallback.
- **On-ledger metrics.** Every payment carries `SourceTag 804681468 (the T54 facilitator tag that the XRPL AI Hub counts)` and is sent to Lumi's wallet, so usage can be counted from public ledger data. Each settlement also logs an `x402_settled` JSON line in Workers Logs.

## Run locally

Requires Node 20+.

```bash
npm install
npm test                 # 27 unit/integration tests (mocked facilitator, fixture data)
npm run typecheck

# Plain Node (testnet config from env or .dev.vars)
XRPL_NETWORK=xrpl:1 PAY_TO=r... npm start          # http://127.0.0.1:8787

# Workers runtime locally (workerd + Durable Object)
cp .dev.vars.example .dev.vars                     # set INVOICE_SECRET (and PAY_TO via wrangler.toml [env.testnet])
npm run dev                                        # wrangler dev --env testnet
```

## Testnet demo (repeatable)

```bash
npm run demo:testnet
```

The demo does the following:
1. creates two throwaway **testnet** wallets via the XRPL faucet (payer and receiver) on first run, stored only in `.testnet/wallets.json`, which is git-ignored and mode 600
2. starts Lumi API in-process with testnet config and the T54 testnet facilitator
3. sends `GET /v1/signal/XRP` and gets **402** with the requirements
4. signs the Payment with the `x402-xrpl` SDK, retries, and gets **200** with data and a `PAYMENT-RESPONSE` receipt
5. replays the same `PAYMENT-SIGNATURE` and gets **402 `invoice_already_used`**
6. runs the one-line agent flow `x402Fetch(/v1/market)` and gets **200**
7. checks both transactions on the ledger (validated, `tesSUCCESS`, destination, amount, the SourceTag, invoice memo) and writes a transcript to `demo/`

To run it against the Workers runtime instead: `npm run dev` in one shell, then `LUMI_API_URL=http://127.0.0.1:8787 npm run demo:testnet`.

Recorded runs (Oct 22 2026), all validated `tesSUCCESS` on XRPL Testnet (the first five at the launch prices of 0.02/0.05 XRP, the last two at the current 0.005/0.01 XRP):

| Run | Endpoint | Amount | Tx |
|---|---|---|---|
| Node | `/v1/signal/XRP` | 0.02 XRP | [D1575C79…3A38EA](https://testnet.xrpl.org/transactions/D1575C79856EF71080F9118B0E3228C397021002D26EAAA9EED300BCA13A38EA) |
| Node | `/v1/market` (x402Fetch) | 0.05 XRP | [59790423…70A4](https://testnet.xrpl.org/transactions/59790423E951F3FA9DD32BA026CEED66CED895DB4232800A072E9E8C3DF870A4) |
| workerd (`wrangler dev`) | `/v1/signal/XRP` | 0.02 XRP | [2E7E0E11…402591](https://testnet.xrpl.org/transactions/2E7E0E119548B9C96F16359BAFABB0A2906EF2F0FD2326473A91042286402591) |
| workerd (`wrangler dev`) | `/v1/market` (x402Fetch) | 0.05 XRP | [E4165025…21BB90](https://testnet.xrpl.org/transactions/E41650253754E23A613C4D593D2B4B2654C7581BB64AFD397D6EE3526A21BB90) |
| Python SDK client | `/v1/levels/XRP` | 0.02 XRP | [355244D3…683F70](https://testnet.xrpl.org/transactions/355244D3602E67D7BF87CB2920B609CF74DF9E9C63B01005F27B020823683F70) |
| Node (current prices) | `/v1/signal/XRP` | 0.005 XRP | [70B12A01…FB2A6E](https://testnet.xrpl.org/transactions/70B12A01E8D8E51E5E9755C858AC94DCB5360BE996C96A6242DF92B994FB2A6E) |
| Node (current prices) | `/v1/market` (x402Fetch) | 0.01 XRP | [4510B9AE…2E7C97](https://testnet.xrpl.org/transactions/4510B9AE3D4B2751D55CB54634DAA4B6C6148809A9E609EE53574C97562E7C97) |

Stablecoin runs (`npm run demo:testnet:stablecoin`, `DEMO_ASSET=RLUSD|USDC`), Oct 22 2026, through the T54 testnet facilitator. Both validated `tesSUCCESS`, and replay was refused:

| Asset | Endpoint | Price | Tx |
|---|---|---|---|
| RLUSD (`524C55…`) | `/v1/slate` | 0.02 | [336D4368…7016D8](https://testnet.xrpl.org/transactions/336D4368F784BC8454A01DCEBBF66F29D8D64878D1C31A712AA865A1BD7016D8) |
| USDC (`555344…`) | `/v1/slate` | 0.02 | [E6C88B93…011F10](https://testnet.xrpl.org/transactions/E6C88B93493DFC6E3450753066008345AC9587FA303EA953276D07E5E0011F10) |

The official testnet faucets for RLUSD (tryrlusd.com, login) and USDC (faucet.circle.com, reCAPTCHA) cannot be scripted. These runs therefore use a **stand-in testnet issuer** (`rhkAVriskfs45BnuJ49jx2GVa9M7Szh9nu`) that issues the same 40-hex currency codes, with the API pointed at it through `RLUSD_ISSUER` / `USDC_ISSUER`. The API, SDK and facilitator run the same IOU code path. `STANDIN=0` uses the official testnet issuer once the payer has been funded from a faucet.

Settle latency was about 6 to 7 s per paid call, including XRPL validation. Full transcripts are in `demo/`.

### Mainnet demo (labeled, self-payment)

> **DEMO:** both wallets belong to Lumi. This shows the live flow working and is **not** organic usage. Exclude it from usage metrics.

`npm run demo:buyer:create` generates a demo-buyer wallet. The seed goes to a mode-600 file outside the repo and the script prints only the address. `DEMO_CONFIRM=yes npm run demo:mainnet` makes one capped XRP x402 call to `api.lumitrades.io` and logs the transaction.

| Date | From (demo buyer) | Endpoint | Amount | Tx |
|---|---|---|---|---|
| 2026-10-22 | `rpvsTYDZmX1j1ndmEFG6YjjZZwp6VRtQRz` | `/v1/signal/XRP` | 0.005 XRP | [356E5C91…4C37E5](https://livenet.xrpl.org/transactions/356E5C9147B4B5D6C1F275C172EF8652E9C082458BAEC4204B569986714C37E5) (`tesSUCCESS`, SourceTag 804681468, 7.4 s) |

## Deploy to `api.lumitrades.io` (Cloudflare Workers)

`wrangler.toml` is ready: mainnet config, custom domain `api.lumitrades.io`, Durable Object binding and migration.

1. Authenticate wrangler with **one** of:
   - `npx wrangler login` (browser OAuth with the Cloudflare account that owns `lumitrades.io`), or
   - `export CLOUDFLARE_API_TOKEN=...` with a token scoped to that account and the `lumitrades.io` zone with **Account › Workers Scripts: Edit**, **Zone › Workers Routes: Edit**, **Zone › DNS: Edit** and **Zone › Zone: Read**. Also set `CLOUDFLARE_ACCOUNT_ID`.
2. `npx wrangler secret put INVOICE_SECRET` (a long random string, e.g. `openssl rand -hex 32`)
3. Optional staging first: `npm run deploy:testnet` (testnet, `lumi-api-testnet.<account>.workers.dev`)
4. `npm run deploy`. Wrangler creates the `api.lumitrades.io` DNS record and certificate, because `custom_domain = true`.
5. Smoke test: `curl https://api.lumitrades.io/health` and `curl -i https://api.lumitrades.io/v1/signal/XRP` (expect 402).

### Mainnet configuration

| Var | Value |
|---|---|
| `XRPL_NETWORK` | `xrpl:0` |
| `PAY_TO` | `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` (Lumi's receiving wallet; the server only needs the address) |
| `FACILITATOR_URL` | `https://xrpl-facilitator-mainnet.t54.ai` |
| `SOURCE_TAG` | `804681468` (T54 facilitator tag, counted by the XRPL AI Hub) |
| `INVOICE_SECRET` | secret, required on mainnet (startup refuses without it) |
| `PRIVATE_NAMES` | optional secret: comma-separated names scrubbed from paid responses (`npx wrangler secret put PRIVATE_NAMES`) |

The server never holds a private key. The payer signs, the facilitator submits, and XRP (or RLUSD/USDC) lands in `PAY_TO`. `PAY_TO` needs RLUSD and USDC trust lines to receive stablecoins. Lumi's mainnet wallet has both (limit 1,000,000 each).

## Data inputs

All paid data comes from Lumi's own published files at `https://lumitrades.io/data/`: `prices`, `signals`, `analysis`, `trades`, `context`
(total cap, dominance, CoinMarketCap Fear & Greed, OKX BTC funding/OI, and USD/JPY + Nikkei from Yahoo Finance) and, since v0.2,
`events.json` + `brief.json` (generated by the site's `scripts/brief.py` from the newsletter and the Shorts' sourced news/event notes).

## MCP server

`mcp/` is a stdio MCP server (`lumi-mcp`) exposing every endpoint as a tool and paying per call with the user's own XRPL wallet
(`XRPL_SEED` env), with per-call spend caps. See [mcp/README.md](mcp/README.md).

## Project layout

```
src/
  index.ts          Workers entry (+ exports the InvoiceGuard Durable Object)
  node.ts           Node HTTP adapter (npm start)
  app.ts            router, free/paid endpoints, "never charge on failure" ordering
  x402.ts           x402 v2 merchant flow: challenge, HMAC invoices, verify/settle, replay guards
  invoice-guard.ts  Durable Object: atomic one-time invoice redemption
  views.ts          whitelisted response shapes (signal, levels, slate, market)
  products.ts       brief, macro/yen, sentiment, events, trades (+ markdown brief, carry-trade + funding rules)
  freshness.ts      "you only pay when you get data": input presence/freshness + content checks before any quote
  sanitize.ts       privacy filter
  data.ts           cached fetch of lumitrades.io/data/*.json
  docs.ts           index, skill.md, /.well-known/x402, openapi.json
  catalog.ts        endpoint + price catalog
  config.ts         env parsing, XRP to drops, network defaults
scripts/            testnet wallet setup, end-to-end demo, replay probe
examples/           minimal agent clients (TypeScript and Python)
test/               vitest suites + fixture data (with privacy canaries)
demo/               recorded testnet transcripts
```

## Roadmap (XRPL Grants milestones)

1. **Mainnet launch** on `api.lumitrades.io`, listed in x402 discovery indexes (OpenAPI and `/.well-known/x402`) and in the XRPL agent ecosystem.
2. **Stablecoin pricing.** Done: RLUSD and Circle USDC are in `accepts[]` next to XRP, priced in USD cents (see *Accepted assets*).
3. **Prepaid credits through payment channels.** Agents that call often open an XRPL PayChannel once and stream signed claims, which brings per-call cost and latency well below one on-ledger Payment per call. Candidates are the `upto`/`paychan` x402 schemes.
4. **Usage metrics dashboard.** Public stats from on-ledger data (payments to `PAY_TO` with `SourceTag 804681468`: calls, unique payer agents, XRP volume per endpoint) plus Workers Analytics Engine. These metrics become the grant KPIs.
5. **More products.** Done: daily brief, yen carry-trade watch, sentiment, events, full track record, and an MCP server wrapper (`mcp/`). Next: historical signal series, a backtest API, webhook/stream subscriptions.
6. **Hardening.** Facilitator failover or self-hosted verification, rate limits, and a Bazaar `extensions` input/output schema in the 402.

## Disclaimer

Lumi API provides analytics for information and education only. It is not financial advice. Trade ideas are paper trades tracked publicly on lumitrades.io, not orders or recommendations. Crypto is volatile and leverage can magnify losses. Do your own research.

## License

MIT. See [LICENSE](LICENSE).
