/**
 * Paid plans outside the per-call data routes: seller monitoring (Monitor, Monitor Plus, Audit) and the data licence
 * feed (Feed, Feed Pro, metered credits). Each payment is one x402 payment (XRPL XRP/RLUSD/USDC or Base USDC) for a
 * fixed term. Nothing auto-renews: renewing means paying again.
 *
 * Test-only price override: when the proven wallet of the enrolment (monitoring) or of the feed key is one of Lumi's
 * own owner-flagged test wallets, the quote is TEST_PRICE_USD instead of the list price and the plan is stored and
 * shown publicly as a test. No one else can get that price: the wallet must be proven by signature first.
 */
import { OWN_WALLETS } from "../sales";
import type { Config } from "../config";
import { usdToDrops } from "../pricing";
import type { Quote } from "../x402";
import { SERVICE_ICON, TRUST_SERVICE_NAME } from "../bazaar";

export type PlanId = "monitor" | "monitor_plus" | "audit" | "feed" | "feed_pro" | "feed_credits";

export interface PlanDef {
  id: PlanId;
  name: string;
  usd: string;
  /** Term in days; null = one-off (Audit, credits). */
  days: number | null;
  family: "monitor" | "feed";
  summary: string;
  path: string;
}

export const DAY_MS = 86_400_000;
export const TERM_DAYS = 30;

export const PLANS: Record<PlanId, PlanDef> = {
  monitor: { id: "monitor", name: "Monitor", usd: "9", days: TERM_DAYS, family: "monitor", path: "/v1/monitor/subscribe/monitor", summary: "30 days: one seller-funded test-buy of 1 endpoint per term (one recheck after a failure) + alerts." },
  monitor_plus: { id: "monitor_plus", name: "Monitor Plus", usd: "29", days: TERM_DAYS, family: "monitor", path: "/v1/monitor/subscribe/monitor_plus", summary: "30 days: weekly seller-funded test-buys of up to 20 endpoints + alerts." },
  audit: { id: "audit", name: "Audit", usd: "99", days: null, family: "monitor", path: "/v1/monitor/subscribe/audit", summary: "One-off: one seller-funded test-buy of every listed endpoint of the seller, with a full report signed by Lumi's wallet." },
  feed: { id: "feed", name: "Feed", usd: "99", days: TERM_DAYS, family: "feed", path: "/v1/feed/subscribe/feed", summary: "30 days: 100,000 bulk lookups, delta feed, full evidence and receipts." },
  feed_pro: { id: "feed_pro", name: "Feed Pro", usd: "199", days: TERM_DAYS, family: "feed", path: "/v1/feed/subscribe/feed_pro", summary: "30 days: 500,000 lookups, delta feed, licensed full snapshot export, status-change webhooks, receipts." },
  feed_credits: { id: "feed_credits", name: "Feed credits", usd: "1.5", days: null, family: "feed", path: "/v1/feed/credits", summary: "1,000 metered lookups (prepaid, credits never expire) on top of the free 1,000/month." },
};
export const MONITOR_PLANS: PlanId[] = ["monitor", "monitor_plus", "audit"];
export const FEED_PLANS: PlanId[] = ["feed", "feed_pro"];

/** Test-buy economics. Every seller-funded test-buy is capped, and a plan's planned test-buy spend must stay within
 *  BUDGET_SHARE of its fee (the rest covers operations); endpoints that break either rule are rejected at enrolment. */
export const MONITOR_LIMITS = {
  maxBuyUsd: 0.1,
  budgetShare: 0.5,
  endpoints: { monitor: 1, monitor_plus: 20, audit: 100 } as Record<string, number>,
  /** Buys per endpoint per term (Monitor: 1 + 1 recheck after a failure; Plus: weekly = up to 5 in 30 days). */
  buysPerEndpoint: { monitor: 2, monitor_plus: 5, audit: 1 } as Record<string, number>,
  /** Cadence of scheduled buys (ms). */
  everyMs: { monitor: TERM_DAYS * DAY_MS, monitor_plus: 7 * DAY_MS, audit: 0 } as Record<string, number>,
  /** A badge needs a passing test this recent. */
  badgeFreshMs: { monitor: 35 * DAY_MS, monitor_plus: 9 * DAY_MS } as Record<string, number>,
  reminderBeforeMs: 3 * DAY_MS,
};

export const FEED_LIMITS = {
  freePerMonth: 1000,
  creditsPerPurchase: 1000,
  included: { feed: 100_000, feed_pro: 500_000 } as Record<string, number>,
  perMinute: { free: 30, credits: 60, feed: 120, feed_pro: 600 } as Record<string, number>,
  maxBatch: 50,
};

export function testWallets(extra: string[] = []): string[] {
  return [...OWN_WALLETS, ...extra];
}
export function isTestWallet(addr: string | null | undefined, extra: string[] = []): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  return testWallets(extra).some((w) => w.toLowerCase() === a);
}

export const TEST_PRICE_USD = "0.01";

export function planPriceUsd(plan: PlanId, test: boolean, testPrice = TEST_PRICE_USD): string {
  return test ? testPrice : PLANS[plan].usd;
}

/** x402 quote for a plan payment. routeKey binds the payment to this plan + subject (enrolment id / key id). */
export function planQuote(cfg: Config, plan: PlanId, subject: string, usd: string, resourceUrl: string, test: boolean): Quote {
  const p = PLANS[plan];
  const rate = cfg.xrpRate?.usd ?? cfg.xrpUsdFallback;
  const amountsIou: Record<string, string> = {};
  for (const o of cfg.ious) amountsIou[o.symbol] = usd;
  return {
    routeKey: `${plan}:${subject}`,
    amountDrops: usdToDrops(usd, rate),
    amountsIou,
    amountEvm: cfg.evm ? String(Math.round(Number(usd) * 1e6)) : undefined,
    description: `${TRUST_SERVICE_NAME} ${p.name}${p.family === "monitor" ? " (x402 seller monitoring)" : " (x402 trust data feed)"}${test ? " (TEST price for an owner-flagged Lumi test wallet)" : ""}. ${p.summary} No auto-renew.`.slice(0, 500),
    resourceUrl,
    service: { serviceName: TRUST_SERVICE_NAME, tags: p.family === "monitor" ? ["monitoring", "x402", "trust"] : ["data", "trust", "x402"], iconUrl: SERVICE_ICON },
    liveDrops: true,
    xrpUsd: rate,
  };
}

/** Public, apolitical price table for discovery docs. */
export function planTable() {
  return Object.values(PLANS).map((p) => ({ plan: p.id, name: p.name, price_usd: p.usd, term_days: p.days, auto_renew: false, path: p.path, summary: p.summary }));
}

/** Shared random id/token helpers. */
export function randHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
}
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s), (x) => x.toString(16).padStart(2, "0")).join("");
}

export const iso = (t: number | null | undefined) => (t == null ? null : new Date(t).toISOString());
