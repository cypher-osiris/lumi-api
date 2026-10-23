import { describe, it, expect } from "vitest";
import { EXAMPLE_COIN, PAID_ENDPOINTS } from "../src/catalog";
import { SAMPLE_ARGS } from "../src/samples";
import { wellKnownX402 } from "../src/docs";
import { loadConfig } from "../src/config";

// The XRPL AI Hub indexes the concrete example URLs; switching them away from XRP retired /v1/signal/XRP and /v1/levels/XRP.
describe("discovery example coin is pinned to XRP", () => {
  it("EXAMPLE_COIN is XRP", () => expect(EXAMPLE_COIN).toBe("XRP"));
  it("signal, levels and lite examples use XRP", () => {
    for (const r of ["signal", "levels", "lite"]) {
      expect(PAID_ENDPOINTS.find((e) => e.route === r)!.example).toBe(`/v1/${r}/XRP`);
      expect(SAMPLE_ARGS[r as keyof typeof SAMPLE_ARGS]).toBe("XRP");
    }
  });
  it("/.well-known/x402 lists signal/XRP, levels/XRP, lite/XRP, scan and funding", () => {
    const urls = wellKnownX402(loadConfig({ XRPL_NETWORK: "xrpl:0", INVOICE_SECRET: "x".repeat(32) } as any), "https://api.lumitrades.io").resources.map((r: any) => r.url);
    for (const p of ["/v1/signal/XRP", "/v1/levels/XRP", "/v1/lite/XRP", "/v1/scan", "/v1/funding"]) expect(urls).toContain(`https://api.lumitrades.io${p}`);
    expect(urls.some((u: string) => /\/v1\/(signal|levels|lite)\/BTC$/.test(u))).toBe(false);
  });
});
