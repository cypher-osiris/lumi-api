import { describe, it, expect } from "vitest";
import { syncBtcLede } from "../src/products";
import { prefersHtml, sitemapXml } from "../src/app";

describe("brief lede sync", () => {
  it("rewrites the newsletter BTC price and 24h % with live numbers", () => {
    const r = syncBtcLede("Bitcoin is around $81,700 (-2.1%) as risk cools. ETH holds $3,000.", 81129.4, -3.93);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("Bitcoin is around $81,129 (-3.93%) as risk cools. ETH holds $3,000.");
  });
  it("replaces a worded 24h % instead of appending a second one", () => {
    expect(syncBtcLede("Bitcoin is around $81,700 (-2.1% in 24h) and alts are off.", 81129, -3.93).text).toBe("Bitcoin is around $81,129 (-3.93% in 24h) and alts are off.");
    expect(syncBtcLede("Bitcoin is around $81,700 (-2.1% in 24h).", 81129, null).text).toBe("Bitcoin is around $81,129.");
  });
  it("handles k-suffixed prices and leaves texts without a BTC price alone", () => {
    expect(syncBtcLede("BTC near $82k today", 81000, 1.2).text).toBe("BTC near $81,000 (+1.2%) today");
    expect(syncBtcLede("Markets are quiet.", 81000, 1).changed).toBe(false);
  });
});

describe("content negotiation and API sitemap", () => {
  it("prefers HTML only when text/html outranks JSON", () => {
    expect(prefersHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(prefersHtml("application/json")).toBe(false);
    expect(prefersHtml("*/*")).toBe(false);
    expect(prefersHtml(null)).toBe(false);
    expect(prefersHtml("application/json, text/html;q=0.5")).toBe(false);
    expect(prefersHtml("text/html;q=0.9, application/json;q=0.5")).toBe(true);
    expect(prefersHtml("text/html;q=0")).toBe(false);
  });
  it("lists entry points", () => {
    const x = sitemapXml("https://api.example");
    expect(x).toContain("<loc>https://api.example/</loc>");
    expect(x).toContain("/v1/samples");
  });
});
