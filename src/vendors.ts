/**
 * Trust layer v0: the vendor allowlist. Only x402 sellers listed here are probed,
 * test-bought and scored. Every entry is a public x402 endpoint that advertised an
 * XRPL (`xrpl:0`) payment option when it was added; pay-to addresses are the ones
 * the vendor's own 402 quote advertised.
 */

export interface VendorEndpoint {
  url: string;
  method: "GET" | "POST";
  /** JSON body for POST endpoints (sent unpaid by the free probe, and paid by the box-side test-buy). */
  body?: Record<string, unknown>;
  /** Price the vendor advertised when the endpoint was listed (the live quote is what the probe records). */
  listed_price: string;
  listed_asset: "XRP" | "RLUSD" | "USDC";
  /** The endpoint Lumi's daily test-buy uses (one per vendor). */
  test_buy?: boolean;
}

export interface Vendor {
  id: string;
  name: string;
  homepage: string;
  /** Pay-to addresses advertised in the vendor's 402 quotes (XRPL r-address and, if offered, EVM). */
  pay_to: { xrpl: string[]; evm?: string[] };
  endpoints: VendorEndpoint[];
}

export const VENDORS: Vendor[] = [
  {
    id: "asksurf",
    name: "AskSurf (x402 data API)",
    homepage: "https://x402.asksurf.ai",
    pay_to: { xrpl: ["ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3"] },
    endpoints: [{ url: "https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed", method: "GET", listed_price: "0.006", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "heurist-mesh",
    name: "Heurist Mesh (x402 agents)",
    homepage: "https://mesh.heurist.xyz",
    pay_to: { xrpl: ["rMPwy3Ntx56Nyc2fKGNm7VRWdmpHSB92Z7"] },
    endpoints: [
      { url: "https://mesh.heurist.xyz/x402/xrpl/agents/FundingRateAgent/get_all_funding_rates", method: "POST", body: {}, listed_price: "0.001", listed_asset: "RLUSD", test_buy: true },
      { url: "https://mesh.heurist.xyz/x402/xrpl/agents/ElfaTwitterIntelligenceAgent/search_mentions", method: "POST", body: { keywords: ["xrp"] }, listed_price: "0.01", listed_asset: "RLUSD" },
    ],
  },
  {
    id: "heurist-router",
    name: "Heurist LLM Router (x402)",
    homepage: "https://router.heurist.xyz",
    pay_to: { xrpl: ["rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ"] },
    endpoints: [
      {
        url: "https://router.heurist.xyz/x402/xrpl/v1/chat/completions",
        method: "POST",
        body: { model: "heurist/deepseek-v4-flash", messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 256 },
        listed_price: "0.0005",
        listed_asset: "RLUSD",
        test_buy: true,
      },
    ],
  },
  {
    id: "printmoneylab",
    name: "PrintMoneyLab (KR market data)",
    homepage: "https://api.printmoneylab.com",
    pay_to: { xrpl: ["raKj7ZGoPy1fWw1vfynuJhyHirpcmUMBhP"] },
    endpoints: [
      { url: "https://api.printmoneylab.com/api/v1/xrpl/kimchi-premium", method: "GET", listed_price: "0.002", listed_asset: "RLUSD", test_buy: true },
      { url: "https://api.printmoneylab.com/api/v1/xrpl/kr-sentiment", method: "GET", listed_price: "0.05", listed_asset: "RLUSD" },
    ],
  },
  {
    id: "monid",
    name: "Monid (x402 XRPL gateway)",
    homepage: "https://monid-x402-xrpl-production.up.railway.app",
    pay_to: { xrpl: ["rGYbaZwYqA5XwFcmxWVdyyut4vUeTD7KcQ"] },
    endpoints: [
      { url: "https://monid-x402-xrpl-production.up.railway.app/t/surf/exchange/funding-history", method: "GET", listed_price: "0.006", listed_asset: "RLUSD", test_buy: true },
      { url: "https://monid-x402-xrpl-production.up.railway.app/t/api.strale.io/x402/fear-greed-index", method: "GET", listed_price: "0.0216", listed_asset: "RLUSD" },
    ],
  },
  {
    id: "invinoveritas",
    name: "invinoveritas signals (babyblueviper)",
    homepage: "https://api.babyblueviper.com",
    pay_to: { xrpl: ["rhFHztjS63h6fs5vXgTotuL7jsuryUvDSF"], evm: ["0x161DbdD73D025E9aEdd4918a67c28e5bf9A87Fb9"] },
    endpoints: [{ url: "https://api.babyblueviper.com/signals/full", method: "GET", listed_price: "0.024649", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "scalpstream",
    name: "ScalpStream crypto feed",
    homepage: "https://feed.scalpstream.com",
    pay_to: { xrpl: ["rwV5T9Gnr5EBH9rJ2G4NABc4bun2XEkHaD"], evm: ["0xD0f5d2E48e67A265174593aCe2cd540337C1564a"] },
    endpoints: [{ url: "https://feed.scalpstream.com/crypto", method: "GET", listed_price: "0.0076", listed_asset: "XRP", test_buy: true }],
  },
];

export const vendorById = (id: string): Vendor | undefined => VENDORS.find((v) => v.id === id);

export function vendorPayTos(v: Vendor): string[] {
  return [...v.pay_to.xrpl, ...(v.pay_to.evm ?? []).map((a) => a.toLowerCase())];
}
