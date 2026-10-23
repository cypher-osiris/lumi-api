import { describe, it, expect } from "vitest";
import { createApp, XRP_MEMO_MS } from "../src/app";
import { toListing, MemoryCatalogStore, QUALITY_REFRESH_MS, REFRESH_SEEN_MS, qualityChanged, QUALITY_CHANGED_SQL } from "../src/trust/catalog";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

// D1 Free allows 100k rows written/day; these guard the write-amplification fixes of 2026-10-23.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const item = (calls: number | null, payers: number | null, last: string | null = "2026-10-20T00:00:00Z", desc = "thing") => ({
  resource: "https://api.seller.com/v1/thing", type: "http", description: desc,
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0xAbCdEf0000000000000000000000000000000001" }],
  quality: { ...(calls == null ? {} : { l30DaysTotalCalls: calls }), ...(payers == null ? {} : { l30DaysUniquePayers: payers }), ...(last ? { lastCalledAt: last } : {}) },
});
const H = 3_600_000;

describe("catalog upsert skips immaterial quality drift", () => {
  it("rolling 30-day counters that drift a little are not rewritten; material moves, nulls and zeros are", async () => {
    const s = new MemoryCatalogStore();
    const T1 = NOW + QUALITY_REFRESH_MS + H;
    expect(await s.upsert([toListing(item(100, 10))!], NOW)).toBe(1);
    expect(await s.upsert([toListing(item(100, 10))!], NOW + H)).toBe(0); // unchanged
    expect(await s.upsert([toListing(item(110, 11, "2026-10-22T00:00:00Z"))!], T1)).toBe(0); // +10% drift, newer last call
    expect(s.rows[0].calls_30d).toBe(100);
    expect(await s.upsert([toListing(item(130, 11))!], T1)).toBe(1); // +30%
    expect(s.rows[0].calls_30d).toBe(130);
    expect(s.rows[0].quality_at).toBe(T1);
    const T2 = T1 + QUALITY_REFRESH_MS + H;
    expect(await s.upsert([toListing(item(130, 0))!], T2)).toBe(1); // payers -> 0
    const T3 = T2 + QUALITY_REFRESH_MS + H;
    expect(await s.upsert([toListing(item(130, 0, null))!], T3)).toBe(1); // last call disappears
    // the 20 h gate still applies to material moves
    expect(await s.upsert([toListing(item(1000, 0, null))!], T3 + H)).toBe(0);
    // description change (signature) always writes; so does the 6-day last_seen refresh
    expect(await s.upsert([toListing(item(130, 0, null, "new desc"))!], T3 + 2 * H)).toBe(1);
    expect(await s.upsert([toListing(item(131, 0, null, "new desc"))!], T3 + 2 * H + REFRESH_SEEN_MS + H)).toBe(1);
    expect(s.rows[0].calls_30d).toBe(131);
  });

  it("small listings: a move of 3 or more that is also 25% counts; 1 -> 2 does not", () => {
    const r = (c: number | null, p: number | null) => ({ calls_30d: c, payers_30d: p, last_called_at: 1 });
    const l = (c: number | null, p: number | null) => ({ ...toListing(item(c, p))!, last_called_at: 2 });
    expect(qualityChanged(r(1, 1), l(2, 1))).toBe(false);
    expect(qualityChanged(r(1, 1), l(4, 1))).toBe(true);
    expect(qualityChanged(r(12, 1), l(15, 1))).toBe(true);
    expect(qualityChanged(r(13, 1), l(16, 1))).toBe(false);
    expect(qualityChanged(r(null, 1), l(5, 1))).toBe(true);
    expect(qualityChanged(r(0, 1), l(1, 1))).toBe(true);
  });

  it("the D1 WHERE clause uses the same thresholds", () => {
    expect(QUALITY_CHANGED_SQL).toContain(">= 3");
    expect(QUALITY_CHANGED_SQL).toContain(">= 0.25 * MAX(");
    expect(QUALITY_CHANGED_SQL).toContain("(catalog.last_called_at IS NULL) <> (excluded.last_called_at IS NULL)");
  });
});

describe("XRP/USD last-known memo is throttled", () => {
  it("persists the fallback rate at most every 30 minutes, not on every 5-minute refresh", async () => {
    let t = NOW;
    const store = new MemoryCatalogStore();
    let sets = 0;
    const orig = store.setMeta.bind(store);
    store.setMeta = async (k: string, v: string) => { if (k === "xrp_usd_rate") sets++; return orig(k, v); };
    const rateFetch = (async (input: any, init: any) => {
      const u = String(input?.url ?? input);
      if (u.includes("coinbase")) return Response.json({ data: { amount: "2.5" } });
      if (u.includes("kraken")) return Response.json({ result: { XXRPZUSD: { c: ["2.5"] } } });
      if (u.includes("bitstamp")) return Response.json({ last: "2.5" });
      return makeFetch(happyFacilitator())(input, init);
    }) as typeof fetch;
    const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", XRP_PRICING: "live" };
    const app = createApp(ENV as any, { fetch: rateFetch, log: () => {}, now: () => t, catalogStore: store } as any);
    for (let i = 0; i < 20; i++) { // 2 hours of refreshes past the 5-minute TTL
      const waits: Promise<unknown>[] = [];
      const r = await (app as any).pricer.rate((p: Promise<unknown>) => waits.push(p));
      expect(r.usd).toBe(2.5);
      await Promise.all(waits);
      t += 6 * 60_000;
    }
    expect(sets).toBeGreaterThan(0);
    expect(sets).toBeLessThanOrEqual(Math.ceil((2 * H) / XRP_MEMO_MS) + 1);
  });
});

describe("catalog write budget leaves headroom under D1 Free (100k rows/day)", () => {
  it("counted catalog phases stop well before the daily limit", async () => {
    const { WRITE_BUDGET } = await import("../src/trust/catalog_service");
    expect(WRITE_BUDGET.ingest).toBeLessThan(WRITE_BUDGET.probe);
    expect(WRITE_BUDGET.probe).toBeLessThanOrEqual(WRITE_BUDGET.evidence);
    expect(WRITE_BUDGET.evidence + 25_000).toBeLessThanOrEqual(100_000); // uncounted writes ~15-20k/day
  });
});
