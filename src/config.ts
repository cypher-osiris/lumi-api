/**
 * Runtime configuration. Every value comes from the environment (wrangler.toml
 * [vars], `wrangler secret`, `.dev.vars`, or process.env when run under Node),
 * so the same code runs on Cloudflare Workers, `wrangler dev` and plain Node.
 */

export type XrplNetwork = "xrpl:0" | "xrpl:1" | "xrpl:2";

export interface Env {
  /** CAIP-2 XRPL network id: xrpl:0 mainnet, xrpl:1 testnet, xrpl:2 devnet. */
  XRPL_NETWORK?: string;
  /** Classic address that receives payments. */
  PAY_TO?: string;
  /** x402 facilitator base URL (verifies + settles the presigned Payment). */
  FACILITATOR_URL?: string;
  /** HMAC key for stateless invoice ids. Set with `wrangler secret put INVOICE_SECRET`. */
  INVOICE_SECRET?: string;
  /** XRPL SourceTag stamped on every payment to this API (on-ledger usage metrics). */
  SOURCE_TAG?: string;
  /** Prices in XRP (decimal strings). */
  PRICE_SIGNAL_XRP?: string;
  PRICE_LEVELS_XRP?: string;
  PRICE_SLATE_XRP?: string;
  PRICE_MARKET_XRP?: string;
  /** Where Lumi's published JSON lives. */
  DATA_BASE_URL?: string;
  /** Cache TTL for upstream data, seconds. */
  DATA_TTL_SECONDS?: string;
  /** Seconds a 402 quote (invoice) stays payable. */
  INVOICE_TTL_SECONDS?: string;
  /** Comma-separated private names to scrub from paid responses. Set with `wrangler secret put PRIVATE_NAMES`. */
  PRIVATE_NAMES?: string;
  /** Public base URL used in docs/discovery (e.g. https://api.lumitrades.io). */
  PUBLIC_BASE_URL?: string;
  /** Durable Object namespace for the strongly-consistent invoice replay guard (recommended). */
  INVOICE_GUARD?: DurableObjectNamespaceLike;
  /** Optional KV namespace used as a weaker (eventually consistent) replay guard. */
  USED_INVOICES?: KVLike;
}

/** Minimal Durable Object namespace surface we use. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** Minimal subset of Cloudflare KV we use (keeps tests and Node runtime simple). */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export type PaidRoute = "signal" | "levels" | "slate" | "market";

export interface Config {
  network: XrplNetwork;
  networkName: "mainnet" | "testnet" | "devnet";
  payTo: string;
  facilitatorUrl: string;
  invoiceSecret: string;
  invoiceSecretIsDevDefault: boolean;
  sourceTag: number;
  pricesDrops: Record<PaidRoute, string>;
  dataBaseUrl: string;
  dataTtlMs: number;
  invoiceTtlSeconds: number;
  publicBaseUrl?: string;
}

export const MAINNET_PAY_TO = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
export const DEFAULT_SOURCE_TAG = 5864; // "LUMI" on a phone keypad
export const FACILITATORS: Record<XrplNetwork, string> = {
  "xrpl:0": "https://xrpl-facilitator-mainnet.t54.ai",
  "xrpl:1": "https://xrpl-facilitator-testnet.t54.ai",
  "xrpl:2": "https://xrpl-facilitator-testnet.t54.ai",
};
export const EXPLORERS: Record<XrplNetwork, string> = {
  "xrpl:0": "https://livenet.xrpl.org/transactions/",
  "xrpl:1": "https://testnet.xrpl.org/transactions/",
  "xrpl:2": "https://devnet.xrpl.org/transactions/",
};

/** Dev-only fallback; refused on mainnet. */
const DEV_INVOICE_SECRET = "lumi-api-dev-only-invoice-secret-do-not-use-on-mainnet";

const DROPS_PER_XRP = 1_000_000n;

/** Convert a decimal XRP string ("0.02") to an integer drops string ("20000") without floats. */
export function xrpToDrops(xrp: string): string {
  const s = xrp.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid XRP amount: ${xrp}`);
  const [whole, frac = ""] = s.split(".");
  const drops = BigInt(whole) * DROPS_PER_XRP + BigInt((frac + "000000").slice(0, 6));
  if (drops <= 0n) throw new Error(`price must be positive: ${xrp}`);
  return drops.toString();
}

export function dropsToXrp(drops: string): string {
  const d = BigInt(drops);
  const whole = d / DROPS_PER_XRP;
  const frac = (d % DROPS_PER_XRP).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function loadConfig(env: Env): Config {
  const network = (env.XRPL_NETWORK || "xrpl:1") as XrplNetwork;
  if (!(network in FACILITATORS)) throw new Error(`unsupported XRPL_NETWORK: ${network}`);
  const networkName = network === "xrpl:0" ? "mainnet" : network === "xrpl:1" ? "testnet" : "devnet";

  const payTo = (env.PAY_TO || (network === "xrpl:0" ? MAINNET_PAY_TO : "")).trim();
  if (!CLASSIC_ADDRESS.test(payTo)) {
    throw new Error("PAY_TO must be set to an XRPL classic address (r...)");
  }

  let invoiceSecret = env.INVOICE_SECRET || "";
  const invoiceSecretIsDevDefault = !invoiceSecret;
  if (!invoiceSecret) {
    if (network === "xrpl:0") throw new Error("INVOICE_SECRET is required on mainnet");
    invoiceSecret = DEV_INVOICE_SECRET;
  }

  const sourceTag = env.SOURCE_TAG ? Number(env.SOURCE_TAG) : DEFAULT_SOURCE_TAG;
  if (!Number.isInteger(sourceTag) || sourceTag < 0 || sourceTag > 0xffffffff) {
    throw new Error("SOURCE_TAG must be a uint32");
  }

  return {
    network,
    networkName,
    payTo,
    facilitatorUrl: (env.FACILITATOR_URL || FACILITATORS[network]).replace(/\/+$/, ""),
    invoiceSecret,
    invoiceSecretIsDevDefault,
    sourceTag,
    pricesDrops: {
      signal: xrpToDrops(env.PRICE_SIGNAL_XRP || "0.005"),
      levels: xrpToDrops(env.PRICE_LEVELS_XRP || "0.005"),
      slate: xrpToDrops(env.PRICE_SLATE_XRP || "0.01"),
      market: xrpToDrops(env.PRICE_MARKET_XRP || "0.01"),
    },
    dataBaseUrl: (env.DATA_BASE_URL || "https://lumitrades.io/data").replace(/\/+$/, ""),
    dataTtlMs: Number(env.DATA_TTL_SECONDS || 60) * 1000,
    invoiceTtlSeconds: Number(env.INVOICE_TTL_SECONDS || 300),
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || undefined,
  };
}
