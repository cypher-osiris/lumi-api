import { MemoryLiveStore, LIVE_UNIVERSE, type LiveRow } from "../src/live";
import { MemoryFeedStore } from "../src/feeds";

const LABELS = ["Strong Buy", "Buy", "Neutral", "Sell", "Strong Sell"];

/** A live row per universe coin (fresh at `now`), deterministic scores. */
export function liveRows(now: number, n = LIVE_UNIVERSE.length): LiveRow[] {
  return LIVE_UNIVERSE.slice(0, n).map((c, i) => {
    const score = Math.round((0.8 - (i % 9) * 0.2) * 100) / 100;
    const label = score >= 0.6 ? LABELS[0] : score >= 0.2 ? LABELS[1] : score > -0.2 ? LABELS[2] : score > -0.6 ? LABELS[3] : LABELS[4];
    const tf = (l: string, s: number) => ({ label: l, score: s, indicators: { rsi: { value: 55 } } } as any);
    return {
      id: c.id, symbol: c.symbol, name: c.name ?? c.symbol, source: c.source ?? "coinbase",
      score, label,
      price: { usd: 100 + i, change_24h_pct: i % 2 ? 1.5 : -1.2, high_24h: 110, low_24h: 90 } as any,
      timeframes: { "1h": tf(label, score), "4h": tf("Neutral", 0), "1d": tf("Sell", -0.3) },
      computed_at: now - 60_000 * (i % 10), daily_at: now - 3_600_000,
    };
  });
}

export function seededStores(now: number, n?: number) {
  const liveStore = new MemoryLiveStore();
  for (const r of liveRows(now, n)) liveStore.rows.set(r.id, r);
  const feedStore = new MemoryFeedStore();
  feedStore.rows.set("funding", {
    id: "funding", fetched_at: now - 120_000,
    doc: {
      venue: "OKX USDT perpetual swaps",
      coins: [
        { symbol: "BTC", id: "bitcoin", instrument: "BTC-USDT-SWAP", rate_pct: 0.01, interval_hours: 8, rate_8h_pct: 0.01, annualized_pct: 10.95, next_funding_time: "2026-10-23T16:00:00.000Z" },
        { symbol: "ETH", id: "ethereum", instrument: "ETH-USDT-SWAP", rate_pct: 0.03, interval_hours: 8, rate_8h_pct: 0.03, annualized_pct: 32.85, next_funding_time: "2026-10-23T16:00:00.000Z" },
        { symbol: "SOL", id: "solana", instrument: "SOL-USDT-SWAP", rate_pct: -0.02, interval_hours: 4, rate_8h_pct: -0.04, annualized_pct: -43.8, next_funding_time: "2026-10-23T12:00:00.000Z" },
      ],
    },
  });
  feedStore.rows.set("fear_greed", {
    id: "fear_greed", fetched_at: now - 300_000,
    doc: {
      source: "CoinMarketCap",
      now: { value: 38, classification: "Fear", at: "2026-10-23T00:00:00.000Z" },
      yesterday: { value: 42, classification: "Neutral", at: "2026-10-22T00:00:00.000Z" },
      last_week: { value: 30, classification: "Fear", at: "2026-10-16T00:00:00.000Z" },
      last_month: { value: 55, classification: "Neutral", at: "2026-09-23T00:00:00.000Z" },
      series_30d: [{ date: "2026-10-22", value: 42 }, { date: "2026-10-23", value: 38 }],
    },
  });
  return { liveStore, feedStore };
}
