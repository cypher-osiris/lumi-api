import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/app";
import worker, { badgeCacheKey } from "../src/index";
import { MemoryTrustStore, type ObservationRow } from "../src/trust/store";
import { MemoryCatalogStore, type BuyRow } from "../src/trust/catalog";
import { normalizeKey, usDate, badgeSvg, badgeMessage, BADGE_CACHE_CONTROL, createBadges } from "../src/trust/badge";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: "https://api.lumitrades.io" };
const D = 86_400_000;
const obs = (vendor_id: string, ts: number, o: Partial<ObservationRow> = {}): ObservationRow => ({
  vendor_id, endpoint: `https://api.${vendor_id}.com/x`, ts, network: "xrpl:0", tx_hash: `${vendor_id}${ts}`.padEnd(64, "0"), amount: "1000", asset: "XRP",
  http_status: 200, data_returned: true, latency_ms: 100, summary: "ok", source: "test", ...o,
});
const buy = (domain: string, ts: number, o: Partial<BuyRow> = {}): BuyRow => ({
  resource: `https://${domain}/v1/x`, domain, ts, network: "eip155:8453", tx_hash: `0x${domain.replace(/\W/g, "")}${ts}`, amount: "10000", asset: "USDC",
  pay_to: "0xabc0000000000000000000000000000000000001", facilitator: null, http_status: 200, data_returned: true, latency_ms: 90, summary: "ok", ...o,
});

function mkApp() {
  const trustStore = new MemoryTrustStore([
    obs("printmoneylab", NOW - 3 * D, { data_returned: false, http_status: 500 }),
    obs("printmoneylab", NOW - D, {}),
    obs("cryptobuddy", NOW - 2 * D, { data_returned: false, http_status: 402 }),
  ]);
  const catalogStore = new MemoryCatalogStore();
  catalogStore.buys.push(
    buy("1gateway.dev", NOW - 5 * D),
    buy("alpha.example.com", NOW - 4 * D, { http_status: null, data_returned: false, inconclusive: "no_response" }),
  );
  const app = createApp(ENV as any, { trustStore, catalogStore, now: () => NOW, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  return { app, trustStore, catalogStore };
}
const get = (app: any, path: string, init?: RequestInit) => app.fetch(new Request(`https://api.lumitrades.io${path}`, init));

describe("badge helpers", () => {
  it("normalises keys and rejects junk", () => {
    expect(normalizeKey("PrintMoneyLab")).toBe("printmoneylab");
    expect(normalizeKey("API.Example.com.")).toBe("api.example.com");
    expect(normalizeKey("%20foo.dev")).toBe("foo.dev");
    for (const bad of ["", "*", "a b", "x%", "../etc", "-foo", "http:%2F%2Fx.com", "%", "a".repeat(70)]) expect(normalizeKey(bad)).toBeNull();
  });
  it("dates are MM-DD-YYYY in UTC", () => {
    expect(usDate(Date.parse("2026-10-03T23:59:00Z"))).toBe("10-03-2026");
  });
});

describe("GET /badge/{key}.svg", () => {
  it("delivered vendor: green, latest date, chain", async () => {
    const { app } = mkApp();
    const r = await get(app, "/badge/printmoneylab.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(r.headers.get("Cache-Control")).toBe(BADGE_CACHE_CONTROL);
    expect(r.headers.get("X-Lumi-Badge")).toBe("delivered");
    const svg = await r.text();
    expect(svg).toContain("Tested by Lumi");
    expect(svg).toContain(`delivered · ${usDate(NOW - D)} · XRPL`);
    expect(svg).toContain("#2e8540");
    expect(svg).toContain("not an endorsement or guarantee");
    expect(svg).not.toMatch(/<script|onload|href=/i);
  });
  it("not delivered vendor is red", async () => {
    const svg = await (await get(mkApp().app, "/badge/cryptobuddy.svg")).text();
    expect(svg).toContain("not delivered ·");
    expect(svg).toContain("#c62828");
  });
  it("host key: catalog buys (Base) and inconclusive (gray)", async () => {
    const { app } = mkApp();
    expect(await (await get(app, "/badge/1gateway.dev.svg")).text()).toContain(`delivered · ${usDate(NOW - 5 * D)} · Base`);
    const inc = await get(app, "/badge/alpha.example.com.svg");
    expect(inc.headers.get("X-Lumi-Badge")).toBe("inconclusive");
    expect(await inc.text()).toContain("#7a7a7a");
  });
  it("host of a curated vendor endpoint maps to that vendor", async () => {
    const r = await get(mkApp().app, "/badge/api.printmoneylab.com.svg");
    expect(r.headers.get("X-Lumi-Badge")).toBe("delivered");
  });
  it("unknown keys say not yet tested; invalid keys render a neutral badge without lookups", async () => {
    const { app } = mkApp();
    for (const k of ["not-a-real-vendor", "nothing.example.org"]) {
      const r = await get(app, `/badge/${k}.svg`);
      expect(r.status).toBe(200);
      expect(r.headers.get("X-Lumi-Badge")).toBe("not_tested");
      expect(await r.text()).toContain("not yet tested");
    }
    const bad = await get(app, "/badge/%2A.svg");
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("invalid key");
    expect((await get(app, "/badge/%2A.json")).status).toBe(400);
  });
  it("Lumi's own domains are never scored", async () => {
    const r = await get(mkApp().app, "/badge/api.lumitrades.io.svg");
    expect(await r.text()).toContain("self, not tested");
  });
  it("HEAD works; non-GET is refused", async () => {
    const { app } = mkApp();
    const h = await get(app, "/badge/printmoneylab.svg", { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe("");
    expect((await app.badge(new Request("https://api.lumitrades.io/badge/printmoneylab.svg", { method: "POST" })))!.status).toBe(405);
  });
  it("escapes everything it renders", () => {
    const svg = badgeSvg({ key: "x", kind: "unknown", name: "<x>", vendor_id: null, homepage: null, verdict: "not_tested", verdict_text: "", latest: null, chain: null, tests: [], pay_tos: [] });
    expect(svg).not.toContain("<x>");
    expect(badgeMessage({ kind: "invalid" } as any)).toBe("invalid key");
  });
});

describe("JSON + result page", () => {
  it("JSON gives one vendor's summary with embed snippets, no tx hashes", async () => {
    const j = await (await get(mkApp().app, "/badge/printmoneylab.json")).json();
    expect(j.verdict).toBe("delivered");
    expect(j.tests).toHaveLength(2);
    expect(j.tests[0].verdict).toBe("delivered");
    expect(JSON.stringify(j)).not.toMatch(/tx_hash|printmoneylab\d{10}/);
    expect(j.embed.markdown).toBe("[![Tested by Lumi: latest dated x402 test-buy result](https://api.lumitrades.io/badge/printmoneylab.svg)](https://api.lumitrades.io/trust/v/printmoneylab)");
    expect(j.disclaimer).toMatch(/not an endorsement/);
    expect(j.disclaimer).toMatch(/Paying Lumi never changes a result/);
    expect(j.right_to_reply.email).toBe("hello@lumitrades.io");
  });
  it("result page shows dated tests, how-it-works, right to reply, disclaimer", async () => {
    const r = await get(mkApp().app, "/trust/v/printmoneylab");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    expect(r.headers.get("Cache-Control")).toBe(BADGE_CACHE_CONTROL);
    const h = await r.text();
    expect(h).toContain(usDate(NOW - D));
    expect(h).toContain("https://lumitrades.io/how-it-works/");
    expect(h).toContain("hello@lumitrades.io");
    expect(h).toContain("not an endorsement");
    expect(h).toContain("/badge/printmoneylab.svg");
    expect(h).toContain("not delivered");
    const un = await (await get(mkApp().app, "/trust/v/nothing.example.org")).text();
    expect(un).toContain("Not yet tested");
    expect(un).toContain("noindex");
  });
  it("there is no listing or wildcard: /badge is static docs, /trust/v needs a key", async () => {
    const { app } = mkApp();
    const d = await (await get(app, "/badge")).json();
    expect(d.kind).toBe("lumi_badge_docs");
    expect(JSON.stringify(d)).not.toContain("cryptobuddy");
    expect((await get(app, "/trust/v")).status).not.toBe(200);
    expect((await get(app, "/badge/%25.svg")).status).toBe(200);
  });
  it("caps tests per key at 10", async () => {
    const trustStore = new MemoryTrustStore(Array.from({ length: 30 }, (_, i) => obs("printmoneylab", NOW - i * 1000)));
    const b = createBadges({ now: () => NOW, latestObservations: (i, n) => trustStore.latestObservations(i, n), buysByDomain: async () => [], selfDomains: [] });
    expect((await b.summary("printmoneylab")).tests).toHaveLength(10);
  });
});

/** A fake D1 that records every statement. */
function fakeD1(rows: Record<string, unknown[]>) {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      const pick = () => Object.entries(rows).find(([k]) => q.includes(k))?.[1] ?? [];
      const st: any = {
        bind: () => st,
        all: async () => ({ results: pick() }),
        first: async () => pick()[0] ?? null,
        run: async () => ({ meta: { changes: 0 } }),
        raw: async () => [],
      };
      return st;
    },
    batch: async (s: unknown[]) => s.map(() => ({ results: [] })),
    exec: async () => ({}),
  };
  return { db, sql };
}

describe("D1 budget: badge paths never write", () => {
  const orig = (globalThis as any).caches;
  let store: Map<string, Response>;
  beforeEach(() => {
    store = new Map();
    (globalThis as any).caches = {
      default: {
        match: async (k: string) => store.get(String(k))?.clone(),
        put: async (k: string, r: Response) => { store.set(String(k), r.clone()); },
      },
    };
  });
  afterEach(() => { (globalThis as any).caches = orig; });

  it("only SELECTs on a miss, nothing on a hit, and query strings / case share one cache entry", async () => {
    const { db, sql } = fakeD1({
      "FROM observations": [obs("printmoneylab", NOW - D)],
      "FROM catalog_buys": [],
    });
    const env = { ...ENV, XRP_PRICING: "live", TRUST_DB: db };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    const paths = ["/badge/printmoneylab.svg", "/badge/PrintMoneyLab.svg?v=1", "/badge/printmoneylab.svg?cb=2", "/trust/v/printmoneylab", "/badge/printmoneylab.json", "/badge/api.example.com.svg", "/badge/api.example.com.svg"];
    for (const p of paths) {
      const r = await worker.fetch(new Request(`https://api.lumitrades.io${p}`), env as any, ctx);
      expect(r.status).toBe(200);
      await Promise.all(waits);
    }
    const writes = sql.filter((q) => !/^\s*SELECT/i.test(q));
    expect(writes).toEqual([]);
    // printmoneylab svg once, page once, json once (+ read-only disclosure lookups), example host once.
    expect(sql.filter((q) => q.includes("FROM observations")).length).toBe(1); // in-isolate memo shares the vendor summary
    expect(sql.filter((q) => q.includes("FROM catalog_buys")).length).toBe(1);
    expect(store.size).toBe(4);
    expect(badgeCacheKey(new URL("https://api.lumitrades.io/badge/X.svg/?a=1"))).toBe("https://api.lumitrades.io/badge/x.svg");
  });
});
