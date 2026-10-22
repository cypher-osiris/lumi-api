/**
 * Live XRP pricing: XRP-denominated quotes track the USD list price of each route.
 *
 * Rate = median of several public spot sources (Coinbase, Kraken, Bitstamp, CoinGecko, Lumi's own prices.json),
 * cached in memory for 5 minutes (stale-while-revalidate up to 30 minutes), then the last known rate persisted
 * in D1, then a static fallback. XRP amounts are rounded UP to 0.0001 XRP so an XRP payment is never worth less
 * than the stablecoin price.
 */
import { PAID_ROUTES, type Config, type PaidRoute } from "./config";

export interface XrpRate { usd: number; source: string; at: number }
export interface RateMemo { get(): Promise<string | null>; set(v: string): Promise<void> }

export const RATE_TTL_MS = 5 * 60_000;
const STALE_MAX_MS = 30 * 60_000;
const LAST_KNOWN_MAX_MS = 7 * 24 * 3_600_000;
const SOURCE_TIMEOUT_MS = 2500;
const SANE = (n: number) => Number.isFinite(n) && n > 0.05 && n < 100;

type Source = { name: string; url: string; pick: (j: any) => unknown };
export const RATE_SOURCES: Source[] = [
  { name: "coinbase", url: "https://api.coinbase.com/v2/prices/XRP-USD/spot", pick: (j) => j?.data?.amount },
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XRPUSD", pick: (j) => (Object.values(j?.result ?? {})[0] as any)?.c?.[0] },
  { name: "bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/xrpusd/", pick: (j) => j?.last },
  { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd", pick: (j) => j?.ripple?.usd },
];

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Drops for a USD price at a rate, rounded up to 0.0001 XRP (100 drops), minimum 100 drops. */
export function usdToDrops(usd: string, rate: number): string {
  const xrp = Number(usd) / rate;
  const units = Math.max(1, Math.ceil(xrp * 10_000 - 1e-9));
  return String(units * 100);
}

export function createXrpPricer(opts: {
  fetch: typeof fetch;
  fallback: number;
  memo?: RateMemo;
  extraSources?: Source[];
  now?: () => number;
  log?: (e: Record<string, unknown>) => void;
}) {
  const now = opts.now ?? Date.now;
  const sources = [...RATE_SOURCES, ...(opts.extraSources ?? [])];
  let cached: XrpRate | undefined;
  let inflight: Promise<XrpRate> | undefined;

  async function one(s: Source): Promise<number | null> {
    try {
      const r = await opts.fetch(s.url, { headers: { Accept: "application/json", "User-Agent": "LumiAPI/0.9 (+https://api.lumitrades.io)" }, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
      if (!r.ok) return null;
      const n = Number(s.pick(await r.json()));
      return SANE(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function fetchLive(): Promise<XrpRate> {
    const got = await Promise.all(sources.map(async (s) => [s.name, await one(s)] as const));
    const ok = got.filter((g): g is readonly [string, number] => g[1] !== null);
    if (ok.length) {
      // Drop outliers more than 5% from the median when there are 3+ quotes.
      const m = median(ok.map((g) => g[1]));
      const kept = ok.length >= 3 ? ok.filter((g) => Math.abs(g[1] - m) / m <= 0.05) : ok;
      const rate: XrpRate = { usd: Number(median(kept.map((g) => g[1])).toFixed(6)), source: `median(${kept.map((g) => g[0]).join(",")})`, at: now() };
      if (opts.memo) await opts.memo.set(JSON.stringify(rate)).catch(() => {});
      return rate;
    }
    if (opts.memo) {
      try {
        const j = JSON.parse((await opts.memo.get()) ?? "null");
        if (j && SANE(Number(j.usd)) && now() - Number(j.at) < LAST_KNOWN_MAX_MS) return { usd: Number(j.usd), source: `last-known (${j.source})`, at: Number(j.at) };
      } catch { /* fall through */ }
    }
    opts.log?.({ event: "xrp_rate_fallback", sources: sources.length });
    return { usd: opts.fallback, source: "static fallback", at: now() };
  }

  function refresh(): Promise<XrpRate> {
    if (!inflight) {
      inflight = fetchLive()
        .then((r) => { cached = r; return r; })
        .finally(() => { inflight = undefined; });
    }
    return inflight;
  }

  return {
    /** Current rate: fresh cache, else stale cache with a background refresh, else a blocking fetch. */
    async rate(waitUntil?: (p: Promise<unknown>) => void): Promise<XrpRate> {
      const age = cached ? now() - cached.at : Infinity;
      const isFallback = cached && cached.source === "static fallback";
      if (cached && age < (isFallback ? 60_000 : RATE_TTL_MS)) return cached;
      if (cached && age < STALE_MAX_MS && !isFallback) {
        const p = refresh().catch(() => cached!);
        if (waitUntil) waitUntil(p);
        return cached;
      }
      return refresh();
    },
    /** Test hook. */
    set(r: XrpRate) { cached = r; },
  };
}
export type XrpPricer = ReturnType<typeof createXrpPricer>;

/** Reprice every route's XRP amount in place (docs, samples, MCP and quotes all read cfg.pricesDrops). */
export function applyRate(cfg: Config, rate: XrpRate): void {
  for (const r of PAID_ROUTES as PaidRoute[]) cfg.pricesDrops[r] = usdToDrops(cfg.usdPrices[r], rate.usd);
  cfg.xrpRate = { usd: rate.usd, source: rate.source, as_of: new Date(rate.at).toISOString() };
}
