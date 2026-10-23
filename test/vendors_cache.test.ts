import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { VENDORS_INDEX_TTL_MS } from "../src/trust";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";

describe("/v1/trust/vendors precomputed index", () => {
  it("rebuilds once, then serves the memo / persisted index until the TTL; trust writes invalidate it", async () => {
    const catalogStore = new MemoryCatalogStore();
    let t = NOW;
    const mk = () => createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => t, catalogStore });
    const a = mk();
    const r1 = await a.fetch(new Request(BASE + "/v1/trust/vendors"));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("X-Lumi-Cache")).toBe("rebuilt");
    const d1 = await r1.json();
    expect(d1.kind).toBe("trust_vendors");
    expect((await a.fetch(new Request(BASE + "/v1/trust/vendors"))).headers.get("X-Lumi-Cache")).toBe("memo");
    // a fresh isolate reads the persisted index
    const b = mk();
    const r3 = await b.fetch(new Request(BASE + "/v1/trust/vendors"));
    expect(r3.headers.get("X-Lumi-Cache")).toBe("index");
    expect(await r3.json()).toEqual(d1);
    // past the TTL it is rebuilt
    t += VENDORS_INDEX_TTL_MS + 1;
    expect((await mk().fetch(new Request(BASE + "/v1/trust/vendors"))).headers.get("X-Lumi-Cache")).toBe("rebuilt");
    // lookups (?url= / ?domain=) are not served from the index
    const q = await mk().fetch(new Request(BASE + "/v1/trust/vendors?domain=example.com"));
    expect(q.headers.get("X-Lumi-Cache")).toBeNull();
  });
});
