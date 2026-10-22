import { describe, it, expect } from "vitest";
import { sanitize, scrubText, setPrivateNames, splitSentences } from "../src/sanitize";
import { yenNote } from "../src/views";

describe("sanitize", () => {
  setPrivateNames("Casey, Morgan");

  it("drops sentences about a configured private name or personal holdings but keeps the rest", () => {
    const s = "XRP is at $1.33. Casey bought more yesterday. Support is $1.30. I hold a big bag. Resistance $1.375.";
    expect(scrubText(s)).toBe("XRP is at $1.33. Support is $1.30. Resistance $1.375.");
    expect(scrubText("Sized to fit my holdings.")).toBe("");
  });

  it("drops sensitive keys recursively and empty strings from arrays", () => {
    const out = sanitize({ a: 1, holdings: [1], nested: { casey_note: "x", ok: "fine", list: ["Morgan says hi.", "ok"] } });
    expect(out).toEqual({ a: 1, nested: { ok: "fine", list: ["ok"] } });
  });

  it("does not split on decimals", () => {
    expect(splitSentences("BTC ~$82.0K (24h $81.6K-$84.8K) fell. BOJ holds at 1.25% on Oct 29-30.")).toHaveLength(2);
  });

  it("extracts the yen note", () => {
    const c = "BTC fell. Yen watch: USD/JPY ~156.9 on safe-haven flows. The BOJ will hold at 1.25%. ETFs bought.";
    expect(yenNote(c)).toBe("Yen watch: USD/JPY ~156.9 on safe-haven flows. The BOJ will hold at 1.25%.");
    expect(yenNote("nothing here.")).toBeNull();
  });
});
