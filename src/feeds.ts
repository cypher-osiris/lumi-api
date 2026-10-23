/**
 * Small live market feeds cached in D1 by the one-minute cron (src/index.ts LIVE_CRON):
 * - funding: perpetual funding rates for the top-50 universe (OKX public API, one request for every USDT swap);
 * - fear_greed: CoinMarketCap Fear & Greed (public chart API: current, yesterday, last week/month, 30-day series).
 * A cron run that refreshes a feed skips the coin slice, so each invocation stays inside the Workers Free budget.
 */
import type { D1Like } from "./config";
import { LIVE_UNIVERSE } from "./live";

export type FeedId = "funding" | "fear_greed";
export interface FeedRow { id: FeedId; fetched_at: number; doc: Record<string, any> }

/** ages(): per feed, the later of fetched_at and a failed attempt's back-off marker (doc.attempt_at). */
/** Refresh cadence and how long a cached copy may be sold. */
export const FEEDS: Record<FeedId, { every_ms: number; stale_ms: number }> = {
  funding: { every_ms: 15 * 60_000, stale_ms: 60 * 60_000 },
  fear_greed: { every_ms: 30 * 60_000, stale_ms: 6 * 3_600_000 },
};

export interface FeedStore {
  get(id: FeedId): Promise<FeedRow | null>;
  ages(): Promise<Partial<Record<FeedId, number>>>;
  put(row: FeedRow): Promise<void>;
}

export class MemoryFeedStore implements FeedStore {
  rows = new Map<FeedId, FeedRow>();
  async get(id: FeedId) { return this.rows.get(id) ?? null; }
  async ages() { return Object.fromEntries([...this.rows.values()].map((r) => [r.id, Math.max(r.fetched_at, Number(r.doc?.attempt_at) || 0)])); }
  async put(row: FeedRow) { this.rows.set(row.id, row); }
}

export class D1FeedStore implements FeedStore {
  constructor(private db: D1Like) {}
  async get(id: FeedId) {
    const x = await this.db.prepare("SELECT id, fetched_at, doc FROM live_feeds WHERE id = ?").bind(id).first();
    return x ? { id: String(x.id) as FeedId, fetched_at: Number(x.fetched_at), doc: JSON.parse(String(x.doc)) } : null;
  }
  async ages() {
    const out = await this.db.prepare("SELECT id, MAX(fetched_at, COALESCE(json_extract(doc,'$.attempt_at'),0)) AS fetched_at FROM live_feeds").all();
    return Object.fromEntries((out.results ?? []).map((x) => [String(x.id), Number(x.fetched_at)]));
  }
  async put(row: FeedRow) {
    await this.db
      .prepare("INSERT INTO live_feeds (id, fetched_at, doc) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at, doc=excluded.doc")
      .bind(row.id, row.fetched_at, JSON.stringify(row.doc))
      .run();
  }
}

const UA = { Accept: "application/json", "User-Agent": "lumi-api-live/1.0 (+https://lumitrades.io)" };
const rd = (x: number, n: number) => Math.round(x * 10 ** n) / 10 ** n;

/** OKX USDT-margined perpetual funding for every universe coin listed there. */
export async function fetchFunding(f: typeof fetch, now: number): Promise<Record<string, any>> {
  const r = await f("https://www.okx.com/api/v5/public/funding-rate?instId=ANY", { headers: UA });
  if (!r.ok) throw new Error(`okx funding: HTTP ${r.status}`);
  const d = (await r.json()) as { code?: string; data?: Record<string, string>[] };
  if (d.code !== "0" || !Array.isArray(d.data)) throw new Error(`okx funding: code ${d.code}`);
  const want = new Map(LIVE_UNIVERSE.map((c) => [`${c.symbol}-USDT-SWAP`, c]));
  const coins: Record<string, unknown>[] = [];
  for (const x of d.data) {
    const c = want.get(x.instId);
    if (!c) continue;
    const rate = Number(x.fundingRate);
    const next = Number(x.fundingTime), prev = Number(x.prevFundingTime);
    const hours = next > prev && prev > 0 ? Math.round((next - prev) / 3_600_000) : 8;
    if (!Number.isFinite(rate)) continue;
    coins.push({
      symbol: c.symbol, id: c.id, instrument: x.instId,
      rate_pct: rd(rate * 100, 5), interval_hours: hours,
      rate_8h_pct: rd((rate * 100 * 8) / hours, 5),
      annualized_pct: rd(rate * 100 * (8760 / hours), 2),
      next_funding_time: Number.isFinite(next) ? new Date(next).toISOString() : null,
    });
  }
  if (!coins.length) throw new Error("okx funding: no universe coins");
  return { venue: "OKX USDT perpetual swaps", fetched_at: new Date(now).toISOString(), coins };
}

/** CoinMarketCap Fear & Greed (the only index Lumi uses), with history. */
export async function fetchFearGreed(f: typeof fetch, now: number): Promise<Record<string, any>> {
  const end = Math.floor(now / 1000);
  const r = await f(`https://api.coinmarketcap.com/data-api/v3/fear-greed/chart?start=${end - 31 * 86400}&end=${end}`, { headers: UA });
  if (!r.ok) throw new Error(`cmc fear-greed: HTTP ${r.status}`);
  const d = ((await r.json()) as any)?.data;
  const hv = d?.historicalValues;
  if (!hv?.now || hv.now.score == null) throw new Error("cmc fear-greed: no current value");
  const pt = (x: any) => (x && x.score != null ? { value: Math.round(Number(x.score)), classification: band(Math.round(Number(x.score))), at: new Date(Number(x.timestamp) * 1000).toISOString() } : null);
  return {
    source: "CoinMarketCap",
    now: pt(hv.now), yesterday: pt(hv.yesterday), last_week: pt(hv.lastWeek), last_month: pt(hv.lastMonth),
    year_high: pt(hv.yearlyHigh), year_low: pt(hv.yearlyLow),
    series_30d: (Array.isArray(d.dataList) ? d.dataList : []).slice(-31).map((x: any) => ({ date: new Date(Number(x.timestamp) * 1000).toISOString().slice(0, 10), value: Math.round(Number(x.score)) })),
  };
}

/** CoinMarketCap bands: 0-20 Extreme fear, 20-40 Fear, 40-60 Neutral, 60-80 Greed, 80-100 Extreme greed. */
export function band(v: number) {
  return v < 20 ? "Extreme fear" : v < 40 ? "Fear" : v < 60 ? "Neutral" : v < 80 ? "Greed" : "Extreme greed";
}

/** The most overdue feed, if any is due. */
export function dueFeed(ages: Partial<Record<FeedId, number>>, now: number): FeedId | null {
  let best: FeedId | null = null, over = 0;
  for (const id of Object.keys(FEEDS) as FeedId[]) {
    const o = now - (ages[id] ?? 0) - FEEDS[id].every_ms;
    if (o >= 0 && (best === null || o > over)) { best = id; over = o; }
  }
  return best;
}

export async function refreshFeed(store: FeedStore, f: typeof fetch, id: FeedId, now: number) {
  const doc = id === "funding" ? await fetchFunding(f, now) : await fetchFearGreed(f, now);
  await store.put({ id, fetched_at: now, doc });
  return { feed: id, ok: true };
}

export const feedFresh = (r: FeedRow | null, now: number): r is FeedRow => !!r && now - r.fetched_at <= FEEDS[r.id].stale_ms;
