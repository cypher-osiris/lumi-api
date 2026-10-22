import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, fakeDurableObjectNamespace, happyFacilitator, jsonResponse, makeFetch, paymentHeaderFor, decodeB64Json, type FakeFacilitator , NOW } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PRIVATE_NAMES: "Canaryname" };
const BASE = "http://lumi.test";

function setup(fac: FakeFacilitator = happyFacilitator(), opts: { dataDown?: boolean } = {}) {
  const logs: any[] = [];
  const app = createApp(ENV, { fetch: makeFetch(fac, opts), log: (e) => logs.push(e), now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { app, get, fac, logs };
}

async function challenge(get: (p: string) => Promise<Response>, path: string) {
  const r = await get(path);
  expect(r.status).toBe(402);
  const header = decodeB64Json(r.headers.get("PAYMENT-REQUIRED"));
  const body = await r.json();
  expect(header).toEqual(body);
  return body.accepts[0];
}

describe("free endpoints", () => {
  it("serves index, health, skill.md, discovery, openapi and coins", async () => {
    const { get } = setup();
    const index = await (await get("/")).json();
    expect(index.paid_endpoints.map((p: any) => [p.path, p.price_xrp])).toEqual([
      ["/v1/signal/{coin}", "0.005"], ["/v1/levels/{coin}", "0.005"], ["/v1/slate", "0.01"], ["/v1/market", "0.01"],
      ["/v1/brief", "0.02"], ["/v1/macro/yen", "0.01"], ["/v1/sentiment", "0.005"], ["/v1/events", "0.005"], ["/v1/trades", "0.01"],
    ]);
    expect(index.guarantee).toMatch(/only pay when you get data/i);
    expect((await get("/health")).status).toBe(200);
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain("PAYMENT-SIGNATURE");
    expect(skill).toContain("x402Fetch");
    expect(skill).toContain("You only pay when you get data");
    expect(skill).toContain("/v1/brief");
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk).toMatchObject({ x402Version: 2, kind: "resource-server" });
    expect(wk.resources).toHaveLength(9);
    expect(wk.resources.map((r: any) => r.url)).toContain(`${BASE}/v1/macro/yen`);
    const oa = await (await get("/openapi.json")).json();
    expect(oa.paths["/v1/signal/{coin}"].get["x-payment-info"].price).toEqual({ mode: "fixed", currency: "XRP", amount: "0.005" });
    const coins = await (await get("/v1/coins")).json();
    expect(coins.count).toBe(13);
    expect(coins.coins.map((c: any) => c.symbol)).toContain("ZBCN");
  });

  it("returns 404 for unknown coins without a payment challenge", async () => {
    const { get, fac } = setup();
    const r = await get("/v1/signal/NOPE");
    expect(r.status).toBe(404);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(fac.calls).toHaveLength(0);
  });
});

describe("x402 paywall", () => {
  it("challenges unpaid requests with x402 v2 requirements", async () => {
    const { get } = setup();
    for (const [path, amount] of [["/v1/signal/xrp", "5000"], ["/v1/levels/ripple", "5000"], ["/v1/slate", "10000"], ["/v1/market", "10000"]]) {
      const req = await challenge(get, path);
      expect(req).toMatchObject({ scheme: "exact", network: "xrpl:1", asset: "XRP", amount, payTo: PAY_TO, maxTimeoutSeconds: 300 });
      expect(req.extra.sourceTag).toBe(5864);
      expect(req.extra.invoiceId).toMatch(/^lumi1\./);
    }
  });

  it("verifies, settles, serves data with a receipt, and refuses replay", async () => {
    const { get, fac, logs } = setup();
    const req = await challenge(get, "/v1/signal/XRP");
    const header = paymentHeaderFor(req);
    const r = await get("/v1/signal/XRP", { "PAYMENT-SIGNATURE": header });
    expect(r.status).toBe(200);
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    expect(fac.calls[0].body.paymentRequirements).toEqual(req);
    const receipt = decodeB64Json(r.headers.get("PAYMENT-RESPONSE"));
    expect(receipt).toMatchObject({ success: true, transaction: "A".repeat(64), network: "xrpl:1" });
    const body = await r.json();
    expect(body).toMatchObject({ kind: "signal", source: "lumitrades.io", coin: { symbol: "XRP" } });
    expect(body.label).toBeTypeOf("string");
    expect(Object.keys(body.timeframes)).toEqual(["1h", "4h", "1d"]);
    expect(body.disclaimer).toMatch(/not financial advice/i);
    expect(body.timestamp).toBeTruthy();
    expect(body.payment.explorer).toBe(`https://testnet.xrpl.org/transactions/${"A".repeat(64)}`);
    expect(logs[0]).toMatchObject({ event: "x402_settled", route: "signal:XRP", amountDrops: "5000" });

    const replay = await get("/v1/signal/XRP", { "PAYMENT-SIGNATURE": header });
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("invoice_already_used");
    expect(fac.calls).toHaveLength(2);
  });

  it("blocks replay across isolates via the Durable Object guard (facilitator would re-confirm the same tx)", async () => {
    const ns = fakeDurableObjectNamespace();
    const fac = happyFacilitator(); // like T54: settle of an already-settled blob returns success again
    const mk = () => createApp({ ...ENV, INVOICE_GUARD: ns }, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
    const isolateA = mk();
    const isolateB = mk();
    const r402 = await isolateA.fetch(new Request(BASE + "/v1/slate"));
    const req = (await r402.json()).accepts[0];
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req) };
    expect((await isolateA.fetch(new Request(BASE + "/v1/slate", { headers: h }))).status).toBe(200);
    const replay = await isolateB.fetch(new Request(BASE + "/v1/slate", { headers: h }));
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("invoice_already_used");
  });

  it("rejects an invoice issued for another route or a tampered amount without calling the facilitator", async () => {
    const { get, fac } = setup();
    const req = await challenge(get, "/v1/signal/XRP");
    const r1 = await get("/v1/signal/BTC", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r1.status).toBe(402);
    expect((await r1.json()).error).toBe("invoice_route_mismatch");
    const r2 = await get("/v1/signal/XRP", { "PAYMENT-SIGNATURE": paymentHeaderFor({ ...req, amount: "1" }) });
    expect(r2.status).toBe(402);
    expect((await r2.json()).error).toBe("payment_requirements_mismatch");
    const r3 = await get("/v1/signal/XRP", { "PAYMENT-SIGNATURE": "%%%not-base64" });
    expect(r3.status).toBe(400);
    expect(fac.calls).toHaveLength(0);
  });

  it("re-quotes when the facilitator says the payment is invalid", async () => {
    const fac: FakeFacilitator = { ...happyFacilitator(), verify: () => jsonResponse(200, { isValid: false, invalidReason: "amount_mismatch" }) };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/market");
    const r = await get("/v1/market", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("verify_failed:amount_mismatch");
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify"]);
  });

  it("returns a typed retryable 503 when verify is unavailable, and the same header works afterwards", async () => {
    let down = true;
    const base = happyFacilitator();
    const fac: FakeFacilitator = { ...base, verify: (b) => (down ? jsonResponse(502, { error: "bad gateway" }) : base.verify(b)) };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/slate");
    const h = paymentHeaderFor(req);
    const r = await get("/v1/slate", { "PAYMENT-SIGNATURE": h });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ retryable: true, phase: "verify", settlementAttempted: false });
    down = false;
    const ok = await get("/v1/slate", { "PAYMENT-SIGNATURE": h });
    expect(ok.status).toBe(200);
  });

  it("reports settlement_status_unknown (409) when settle cannot be confirmed", async () => {
    const fac: FakeFacilitator = { ...happyFacilitator(), settle: () => { throw new Error("socket hang up"); } };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/levels/BTC");
    const r = await get("/v1/levels/BTC", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "settlement_status_unknown", settlementAttempted: true });
  });

  it("re-quotes when settlement fails on ledger", async () => {
    const fac: FakeFacilitator = { ...happyFacilitator(), settle: () => jsonResponse(200, { success: false, errorReason: "tecUNFUNDED_PAYMENT", transaction: "", network: "xrpl:1" }) };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/levels/XRP");
    const r = await get("/v1/levels/XRP", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("settle_failed:tecUNFUNDED_PAYMENT");
  });

  it("never asks for money when upstream data is unavailable", async () => {
    const { get, fac } = setup(happyFacilitator(), { dataDown: true });
    const r = await get("/v1/market");
    expect(r.status).toBe(503);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(fac.calls).toHaveLength(0);
  });
});

describe("paid payloads", () => {
  async function paid(path: string) {
    const { get } = setup();
    const req = await challenge(get, path);
    const r = await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(200);
    return r.json();
  }

  it("levels: support/resistance/projection, with private content stripped", async () => {
    const b = await paid("/v1/levels/XRP");
    expect(b.support.length).toBeGreaterThan(0);
    expect(b.resistance.length).toBeGreaterThan(0);
    expect(b.projection).toHaveProperty("bull");
    expect(JSON.stringify(b)).not.toMatch(/canaryname/i);
    expect(b.commentary).toContain("XRP held $1.30.");
  });

  it("slate: active ideas with entry/stop/targets/leverage, no private notes", async () => {
    const b = await paid("/v1/slate");
    expect(b.ideas.length).toBeGreaterThan(0);
    for (const i of b.ideas) {
      expect(["open", "pending"]).toContain(i.status);
      expect(i).toHaveProperty("entry");
      expect(i).toHaveProperty("stop");
      expect(i).toHaveProperty("targets");
      expect(i).toHaveProperty("leverage");
      expect(i).not.toHaveProperty("source");
    }
    const s = JSON.stringify(b);
    expect(s).not.toMatch(/my holdings|user-specified|canaryname/i);
    expect(b.track_record).toHaveProperty("win_rate_pct");
  });

  it("market: BTC backdrop, macro with yen note, breadth", async () => {
    const b = await paid("/v1/market");
    expect(b.btc_backdrop.coin.symbol).toBe("BTC");
    expect(b.btc_backdrop.projection).toHaveProperty("bear");
    expect(b.macro.yen_note).toMatch(/yen|USD\/JPY/i);
    expect(b.breadth.coins_tracked).toBe(13);
  });
});
