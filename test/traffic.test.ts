import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { D1TrafficStore, TRAFFIC_BATCHES_DDL, MemoryTrafficStore, TrafficBuffer, uaClass, safePath, trafficRow, trafficSummary, type TrafficRow } from "../src/traffic";
import { DATA, NOW, FACILITATOR, PAY_TO, makeFetch, happyFacilitator } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, OWNER_MCP_KEY: "owner-key-for-tests-0123456789abcdef", INVOICE_SECRET: "test-secret" };
const BASE = "http://lumi.test";

describe("private traffic log", () => {
  it("never stores raw IPs, query strings or the MCP owner key path", async () => {
    const req = new Request(BASE + "/mcp/supersecretkey?x=1", { headers: { "CF-Connecting-IP": "198.51.100.23", "User-Agent": "curl/8.0", Referer: "https://news.example.com/a?b=c" } });
    const row = await trafficRow(req, new Response("x", { status: 200 }), "salt", NOW);
    expect(row.path).toBe("/mcp/:key");
    expect(JSON.stringify(row)).not.toContain("198.51.100.23");
    expect(JSON.stringify(row)).not.toContain("supersecretkey");
    expect(row.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.ref_host).toBe("news.example.com");
    expect(row.ua_class).toBe("cli");
    expect(safePath("/v1/brief")).toBe("/v1/brief");
    expect(uaClass("Mozilla/5.0 (Macintosh) Chrome/130 Safari/537")).toBe("browser");
    expect(uaClass("Mozilla/5.0 (compatible; GPTBot/1.2)")).toBe("ai-agent");
    expect(uaClass("node")).toBe("sdk");
  });

  it("logs requests and serves an owner-only summary with 402s vs paid and daily counts", async () => {
    const trafficStore = new MemoryTrafficStore();
    const app = createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, trafficStore, trafficFlushMs: 10 * 60_000 });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    for (const [p, ip] of [["/v1/brief", "203.0.113.1"], ["/v1/brief", "203.0.113.2"], ["/", "203.0.113.1"], ["/v1/coins", "203.0.113.1"]]) {
      const req = new Request(BASE + p, { headers: { "CF-Connecting-IP": ip, "User-Agent": "x402-test/1.0" } });
      const res = await app.fetch(req, ctx);
      app.logTraffic(req, res, ctx);
    }
    await Promise.all(waits);
    // Buffered in memory: nothing written per request.
    expect(trafficStore.list.length).toBe(0);
    await app.flushTraffic();
    expect(trafficStore.list.length).toBe(1);
    expect(trafficStore.counted).toBe(4);
    expect(trafficStore.list[0].b.r402).toBe(2);
    expect(JSON.stringify(trafficStore.list)).not.toContain("203.0.113");

    const denied = await app.fetch(new Request(BASE + "/v1/owner/traffic"));
    expect(denied.status).toBe(401);
    const r = await app.fetch(new Request(BASE + "/v1/owner/traffic?days=3", { headers: { Authorization: "Bearer owner-key-for-tests-0123456789abcdef" } }));
    expect(r.status).toBe(200);
    const s: any = await r.json();
    expect(s.totals.requests).toBe(4);
    expect(s.totals.payment_required_402).toBe(2);
    expect(s.totals.paid).toBe(0);
    expect(s.totals.visitor_days).toBe(2);
    expect(s.daily.length).toBe(3);
    expect(s.top_paths[0]).toMatchObject({ key: "/v1/brief", requests: 2 });
    expect(JSON.stringify(s)).not.toContain("203.0.113");
  });

  it("can be turned off with TRAFFIC_LOG=0", async () => {
    const trafficStore = new MemoryTrafficStore();
    const app = createApp({ ...ENV, TRAFFIC_LOG: "0" } as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, trafficStore });
    const req = new Request(BASE + "/v1/coins");
    const waits: Promise<unknown>[] = [];
    app.logTraffic(req, await app.fetch(req), { waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);
    await app.flushTraffic();
    expect(trafficStore.list.length).toBe(0);
  });

  const row = (over: Partial<TrafficRow> = {}): TrafficRow => ({
    ts: NOW, day: new Date(NOW).toISOString().slice(0, 10), method: "GET", path: "/v1/brief", status: 402, ua: "node", ua_class: "sdk",
    ref_host: null, ip_hash: "aaaaaaaaaaaaaaaa", country: "US", is_402: true, paid: false, ...over,
  });

  it("writes one batch per flush window instead of one row per request (D1 write budget)", async () => {
    const store = new MemoryTrafficStore();
    const buf = new TrafficBuffer(store, { flushMs: 120_000, maxRequests: 500 });
    const waits: Promise<void>[] = [];
    for (let i = 0; i < 300; i++) {
      const p = buf.add(row({ ts: NOW + i * 100, ip_hash: `ip${i % 7}`.padEnd(16, "0"), path: i % 3 ? "/v1/brief" : "/openapi.json", status: i % 3 ? 402 : 200, is_402: i % 3 !== 0 }), NOW + i * 100);
      if (p) waits.push(p);
    }
    expect(waits.length).toBe(0);
    expect(store.list.length).toBe(0);
    // window elapsed: the next request flushes everything counted so far as ONE row
    const p = buf.add(row({ ts: NOW + 121_000 }), NOW + 121_000);
    expect(p).toBeDefined();
    await p;
    expect(store.list.length).toBe(1);
    const b = store.list[0].b;
    expect(b.requests).toBe(301);
    expect(b.paths["/v1/brief"][0]).toBe(201);
    expect(b.paths["/openapi.json"]).toEqual([100, 0, 0]);
    expect(b.ips.length).toBe(8); // 7 + the flushing request's visitor
    // request cap also flushes
    const capped = new TrafficBuffer(store, { flushMs: 3_600_000, maxRequests: 10 });
    let flushes = 0;
    for (let i = 0; i < 25; i++) { const q = capped.add(row(), NOW); if (q) { flushes++; await q; } }
    expect(flushes).toBe(2);
    expect(capped.size).toBe(5);
  });

  it("starts a new batch when the UTC day changes", async () => {
    const store = new MemoryTrafficStore();
    const buf = new TrafficBuffer(store, { flushMs: 3_600_000 });
    buf.add(row({ day: "2026-10-23" }), NOW);
    await buf.add(row({ day: "2026-10-24" }), NOW + 1000);
    await buf.flush();
    expect(store.list.map((x) => [x.b.day, x.b.requests])).toEqual([["2026-10-23", 1], ["2026-10-24", 1]]);
  });

  it("owner summary merges aggregate batches with legacy raw rows (counts, 402 vs paid, visitors, top lists)", async () => {
    const store = new MemoryTrafficStore();
    const day = new Date(NOW).toISOString().slice(0, 10);
    store.rows.push(row({ ts: NOW - 1000, ip_hash: "legacy0000000000", path: "/v1/coins", status: 200, is_402: false }));
    const buf = new TrafficBuffer(store, { flushMs: 3_600_000 });
    buf.add(row({ ip_hash: "legacy0000000000" }), NOW);
    buf.add(row({ ip_hash: "new0000000000000", status: 200, is_402: false, paid: true, ua: "Mozilla/5.0 Chrome/130", ua_class: "browser", ref_host: "news.example.com" }), NOW);
    await buf.flush();
    const s: any = await trafficSummary(store, NOW, 1);
    expect(s.totals.requests).toBe(3);
    expect(s.totals.payment_required_402).toBe(1);
    expect(s.totals.paid).toBe(1);
    expect(s.totals.paid_per_402).toBe(1);
    expect(s.totals.visitor_days).toBe(2);
    expect(s.totals.by_status).toEqual({ "200": 2, "402": 1 });
    expect(s.daily).toEqual([{ day, requests: 3, visitors: 2, payment_required_402: 1, paid: 1, browser: 1, non_browser: 2 }]);
    expect(s.top_paths[0]).toEqual({ key: "/v1/brief", requests: 2 });
    expect(s.top_paid_paths).toEqual([{ key: "/v1/brief", requests: 1 }]);
    expect(s.top_referrers).toEqual([{ key: "news.example.com", requests: 1 }]);
    expect(s.top_user_agents[0]).toEqual({ key: "sdk: node", requests: 2 });
  });

  it("D1 store: reads tolerate and writes create the table if migration 0014 is not applied yet", async () => {
    let table = false;
    const sqls: string[] = [];
    const db: any = {
      prepare: (sql: string) => {
        const stmt = {
          bind: () => stmt,
          run: async () => {
            sqls.push(sql);
            if (sql.startsWith("CREATE TABLE")) { table = true; return {}; }
            if (sql.includes("traffic_batches") && !table) throw new Error("D1_ERROR: no such table: traffic_batches: SQLITE_ERROR");
            return {};
          },
          all: async () => { if (!table) throw new Error("no such table: traffic_batches"); return { results: [] }; },
        };
        return stmt;
      },
    };
    const st = new D1TrafficStore(db);
    expect(await st.batches(0)).toEqual([]);
    const buf = new TrafficBuffer(st, { flushMs: 0 });
    await buf.add(row(), NOW);
    expect(sqls.filter((x) => x.startsWith("INSERT")).length).toBe(2);
    expect(sqls).toContain(TRAFFIC_BATCHES_DDL);
    expect(table).toBe(true);
  });
});
