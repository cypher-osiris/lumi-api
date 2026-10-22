import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { toListing, normalizeUrl, normalizeDomain, registrableDomain, MemoryCatalogStore, probeRow, LABELS } from "../src/trust/catalog";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52) };
const BASE = "http://lumi.test";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0xAbCdEf0000000000000000000000000000000001";
const BUYER = "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const item = (i: number, extra: Record<string, unknown> = {}) => ({
  resource: `https://API.Seller${i % 2}.com/v1/thing/${i}`,
  type: "http",
  description: `thing ${i}`,
  serviceName: `Seller ${i % 2}`,
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 100 - i, l30DaysUniquePayers: 3 },
  lastUpdated: new Date().toISOString(),
  ...extra,
});
const ITEMS = [item(1), item(2), item(3), { ...item(4), type: "mcp" }];

function b64(o: unknown) {
  return btoa(JSON.stringify(o));
}

function catalogFetch(base: typeof fetch, calls: string[] = []): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources")) {
      const u = new URL(url);
      const off = Number(u.searchParams.get("offset")), lim = Number(u.searchParams.get("limit"));
      return new Response(JSON.stringify({ items: ITEMS.slice(off, off + lim), pagination: { limit: lim, offset: off, total: ITEMS.length } }), { headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://api.seller0.com/")) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER }] }) } });
    }
    if (url.startsWith("https://api.seller1.com/")) return new Response("ok", { status: 200 });
    if (url.startsWith("https://rdap.org/domain/")) return new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }] }));
    if (url === "https://base.rpc.test/") {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getTransactionReceipt")
        return new Response(JSON.stringify({ result: { status: "0x1", blockNumber: "0x10", logs: [{ address: USDC, topics: [TOPIC, "0x" + "0".repeat(24) + BUYER.slice(2), "0x" + "0".repeat(24) + SELLER.slice(2)], data: "0x" + (10000).toString(16) }] } }));
      return new Response(JSON.stringify({ result: { timestamp: "0x" + Math.floor(NOW / 1000).toString(16) } }));
    }
    return base(input, init);
  }) as typeof fetch;
}

function mkApp(store = new MemoryCatalogStore(), calls: string[] = [], now = NOW) {
  const app = createApp({ ...ENV, BASE_RPC_URL: "https://base.rpc.test/" } as any, { fetch: catalogFetch(makeFetch(happyFacilitator()), calls), now: () => now, catalogStore: store });
  return { app, store };
}
const get = (app: any, path: string) => app.fetch(new Request(BASE + path)).then(async (r: Response) => ({ status: r.status, body: await r.json() as any }));
const owner = { Authorization: "Bearer " + "k".repeat(52), "Content-Type": "application/json" };

describe("catalog parsing", () => {
  it("normalizes urls, domains and registrable domains", () => {
    expect(normalizeUrl("https://API.X.com/a/")).toBe("https://api.x.com/a");
    expect(normalizeUrl("ftp://x")).toBeNull();
    expect(normalizeDomain("https://www.Example.com/x")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("foo.workers.dev")).toBe("foo.workers.dev");
    expect(registrableDomain("api.seller.com")).toBe("seller.com");
  });
  it("toListing: lowercased payTo, USD price, MCP method, signature ignores quality", () => {
    const l = toListing(item(1))!;
    expect(l.domain).toBe("api.seller1.com");
    expect(l.pay_tos).toEqual([SELLER.toLowerCase()]);
    expect(l.price_usd).toBe("0.01");
    expect(toListing({ ...item(1), type: "mcp" })!.method).toBe("MCP");
    expect(toListing({ ...item(1), quality: { l30DaysTotalCalls: 5 } })!.sig).toBe(l.sig);
    expect(toListing({ resource: "nope" })).toBeNull();
  });
  it("probeRow: valid quote with matching payTo and price; non-402 is not valid", async () => {
    const s = new MemoryCatalogStore();
    await s.upsert([toListing(item(2))!, toListing(item(1))!], NOW);
    const f = catalogFetch(fetch);
    const ok = await probeRow(f, s.rows[0], NOW);
    expect(ok).toMatchObject({ valid: true, pay_to_match: true, price_match: true, price_usd: "0.01", status: 402, hist: "1" });
    const bad = await probeRow(f, s.rows[1], NOW);
    expect(bad).toMatchObject({ valid: false, status: 200, hist: "0" });
    expect(bad.error).toContain("HTTP 200");
  });
});

describe("catalog pipeline", () => {
  it("owner ingest (inline without a queue), cron probes, lookups by url/domain/payTo", async () => {
    const calls: string[] = [];
    const { app, store } = mkApp(new MemoryCatalogStore(), calls);
    expect((await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST" }))).status).toBe(401);
    const r = await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    expect(r.status).toBe(200);
    expect(store.rows).toHaveLength(4);
    await app.scheduled();
    expect(store.rows.filter((x) => x.probe_ts != null)).toHaveLength(3); // MCP entry not probed
    expect(calls.some((c) => c.startsWith("https://rdap.org/domain/seller0.com"))).toBe(true);

    const byUrl = await get(app, "/v1/trust/vendors?url=" + encodeURIComponent("https://api.seller0.com/v1/thing/2"));
    expect(byUrl.status).toBe(200);
    expect(byUrl.body.observed).toBe(true);
    expect(byUrl.body.catalog.entries[0].tier).toBe(LABELS.quote_verified);
    expect(byUrl.body.catalog.entries[0].domain_age.age_days).toBeGreaterThan(2000);
    const byDom = await get(app, "/v1/trust/vendors?domain=seller1.com");
    expect(byDom.body.catalog.total_matches).toBe(2);
    expect(byDom.body.catalog.entries[0].tier).toBe(LABELS.quote_failed);
    const byPay = await get(app, "/v1/trust/vendors?payTo=" + SELLER.toUpperCase().replace("0X", "0x"));
    expect(byPay.body.catalog.total_matches).toBe(4);
    const none = await get(app, "/v1/trust/vendors?domain=unknown.example");
    expect(none.body).toMatchObject({ observed: false });
    expect(none.body.note).toContain("not a negative signal");
    expect(JSON.stringify([byUrl, byDom, byPay, none])).not.toMatch(/\bscam\b/i);
  });

  it("self entry is 'self, not scored'", async () => {
    const { app } = mkApp();
    const r = await get(app, "/v1/trust/vendors?domain=api.lumitrades.io");
    expect(r.body.self.label).toBe("self, not scored");
    const p = await get(app, "/v1/trust/vendors?payTo=" + PAY_TO);
    expect(p.body.self.label).toBe("self, not scored");
    const list = await get(app, "/v1/trust/vendors");
    expect(list.body.self.label).toBe("self, not scored");
    expect(list.body.catalog.lookup).toContain("payTo");
  });

  it("owner observation: verified on Base, from a Lumi buyer to a listed payTo -> purchase-verified", async () => {
    const { app, store } = mkApp();
    await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    const body = { resource: "https://api.seller0.com/v1/thing/2", network: "eip155:8453", tx_hash: "0x" + "a".repeat(64), data_returned: true, http_status: 200, summary: "returned JSON with 3 fields", facilitator: "cdp" };
    const post = (b: unknown) => app.fetch(new Request(BASE + "/v1/trust/catalog/observations", { method: "POST", headers: owner, body: JSON.stringify(b) }));
    expect((await post({ ...body, summary: "total scam" })).status).toBe(400);
    expect((await post({ ...body, resource: "https://nope.example/x" })).status).toBe(404);
    const r = await post(body);
    expect(r.status).toBe(201);
    expect((await post(body)).status).toBe(200);
    expect(store.buys).toHaveLength(1);
    const look = await get(app, "/v1/trust/vendors?url=" + encodeURIComponent(body.resource));
    expect(look.body.catalog.entries[0].tier).toBe("purchase-verified");
    expect(look.body.catalog.entries[0].purchases[0].explorer).toContain("basescan.org/tx/0x");
    const pop = await get(app, "/v1/trust/catalog?popular=1&max_usd=0.05");
    expect(pop.body.entries.length).toBe(3);
  });

  it("cron schedules probe jobs on a queue and the consumer processes them", async () => {
    const sent: any[] = [];
    const store = new MemoryCatalogStore();
    await store.upsert(ITEMS.map(toListing).filter(Boolean) as any, NOW);
    const app = createApp(ENV as any, { fetch: catalogFetch(makeFetch(happyFacilitator())), now: () => NOW, catalogStore: store, queue: { sendBatch: async (m) => { sent.push(...m); } } });
    await app.scheduled();
    expect(sent.map((m: any) => m.body)).toEqual([{ kind: "ingest", offset: 0 }, { kind: "probe", after: 0 }]);
    expect(await store.getMeta("ingest_cursor")).toBe("25");
    expect(store.rows.every((r) => r.probe_ts == null)).toBe(true);
    await app.queue(sent[1].body);
    expect(store.rows.filter((r) => r.probe_ts != null)).toHaveLength(3);
    expect(await store.getMeta("probe_cursor")).toBe("36");
    expect(Number(await store.getMeta("writes:2026-10-22"))).toBeGreaterThan(0);
  });

  it("daily D1 write budget: jobs are skipped once it is used up", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert(ITEMS.map(toListing).filter(Boolean) as any, NOW);
    await store.setMeta("writes:2026-10-22", "99000");
    const app = createApp(ENV as any, { fetch: catalogFetch(makeFetch(happyFacilitator())), now: () => NOW, catalogStore: store, queue: { sendBatch: async () => {} } });
    expect(await app.queue({ kind: "probe", after: 0 })).toEqual({ skipped: "daily write budget" });
    expect(await app.queue({ kind: "ingest", offset: 0 })).toEqual({ skipped: "daily write budget" });
    expect(store.rows.every((r) => r.probe_ts == null)).toBe(true);
  });
});

describe("lookup via MCP and A2A", () => {
  it("lumi_vendor_scores takes url/domain/payTo; A2A vendor_trust takes data.payTo", async () => {
    const { app } = mkApp();
    await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    const mcp = await app.fetch(new Request(BASE + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lumi_vendor_scores", arguments: { domain: "seller0.com" } } }),
    }));
    const doc = JSON.parse(((await mcp.json()) as any).result.content[0].text);
    expect(doc).toMatchObject({ kind: "trust_lookup", observed: true });
    const tools = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }));
    const t = ((await tools.json()) as any).result.tools.find((x: any) => x.name === "lumi_vendor_scores");
    expect(Object.keys(t.inputSchema.properties)).toEqual(["url", "domain", "payTo", "vendor_id"]);
    const a2a = await app.fetch(new Request(BASE + "/a2a", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "message/send", params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "data", data: { payTo: SELLER.toLowerCase() } }] } } }),
    }));
    const s = JSON.stringify(await a2a.json());
    expect(s).toContain("trust_lookup");
    expect(s).toContain("catalog match");
  });
});
