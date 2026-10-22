/**
 * Seed observations: Lumi's real paid buys on 2026-10-22 (XRPL mainnet, all tesSUCCESS).
 * Mirrors migrations/0002_seed_2026_10_22.sql (a test keeps the two in sync).
 */
import type { ObservationRow } from "./store";

export const SEED_OBSERVATIONS: ObservationRow[] = [
  {
    vendor_id: "scalpstream",
    endpoint: "https://feed.scalpstream.com/crypto",
    ts: Date.parse("2026-10-22T12:47:10Z"),
    network: "xrpl:0",
    tx_hash: "579DA9D42E89594F38A278885DF61D7549DE53DA2045D104874AD85E152EF9A5",
    amount: "0.007548",
    asset: "XRP",
    http_status: 200,
    data_returned: true,
    latency_ms: null,
    summary: "Paid 0.007548 XRP; HTTP 200; response contained data (ranked list of crypto candidates). No PAYMENT-RESPONSE header was returned.",
    source: "lumi_buy",
  },
  {
    vendor_id: "asksurf",
    endpoint: "https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed",
    ts: Date.parse("2026-10-22T12:52:10Z"),
    network: "xrpl:0",
    tx_hash: "FEE22376B67B394D997BE95E3D585C7143A36657C74B7D6926495CEA74CCD163",
    amount: "0.006",
    asset: "RLUSD",
    http_status: 502,
    data_returned: false,
    latency_ms: null,
    summary: 'Paid 0.006 RLUSD; HTTP 502; response contained no data (body: error "surf_upstream_error", upstream_status 401).',
    source: "lumi_buy",
  },
  {
    vendor_id: "asksurf",
    endpoint: "https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed",
    ts: Date.parse("2026-10-22T12:53:20Z"),
    network: "xrpl:0",
    tx_hash: "134C85B67820077D4CAD2501C680A70B8D78BE076D7BEA558A5017F1B51B78D5",
    amount: "0.006",
    asset: "RLUSD",
    http_status: 502,
    data_returned: false,
    latency_ms: null,
    summary: 'Paid 0.006 RLUSD; HTTP 502; response contained no data (body: error "surf_upstream_error", upstream_status 401).',
    source: "lumi_buy",
  },
  {
    vendor_id: "heurist-mesh",
    endpoint: "https://mesh.heurist.xyz/x402/xrpl/agents/FundingRateAgent/get_all_funding_rates",
    ts: Date.parse("2026-10-22T12:56:22Z"),
    network: "xrpl:0",
    tx_hash: "07929A44333D9269CD4C92DE6A4A917B0BA28F1A3F244F1992B3F61BDA366BA0",
    amount: "0.001",
    asset: "RLUSD",
    http_status: 200,
    data_returned: false,
    latency_ms: null,
    summary: "Paid 0.001 RLUSD; HTTP 200; response contained an empty result (rates: []).",
    source: "lumi_buy",
  },
];
