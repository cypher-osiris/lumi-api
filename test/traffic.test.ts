import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrafficStore, uaClass, safePath, trafficRow } from "../src/traffic";
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
    const app = createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, trafficStore });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    for (const [p, ip] of [["/v1/brief", "203.0.113.1"], ["/v1/brief", "203.0.113.2"], ["/", "203.0.113.1"], ["/v1/coins", "203.0.113.1"]]) {
      const req = new Request(BASE + p, { headers: { "CF-Connecting-IP": ip, "User-Agent": "x402-test/1.0" } });
      const res = await app.fetch(req, ctx);
      app.logTraffic(req, res, ctx);
    }
    await Promise.all(waits);
    expect(trafficStore.rows.length).toBe(4);
    expect(trafficStore.rows.filter((r) => r.is_402).length).toBe(2);

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
    expect(trafficStore.rows.length).toBe(0);
  });
});
