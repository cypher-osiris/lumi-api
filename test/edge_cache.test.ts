import { describe, expect, it } from "vitest";
import { restoreHit, storable } from "../src/index";

describe("edge cache headers", () => {
  it("keeps the app's Cache-Control on hits even if the edge rewrites it", async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" } });
    const stored = storable(res);
    expect(stored.headers.get("X-Lumi-Cache-Control")).toBe("public, max-age=300");
    const h = new Headers(stored.headers);
    h.set("Cache-Control", "public, max-age=14400"); // what Cloudflare's Browser Cache TTL does on a hit
    const out = restoreHit(new Response(await stored.text(), { status: 200, headers: h }));
    expect(out.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(out.headers.has("X-Lumi-Cache-Control")).toBe(false);
    expect(await out.json()).toEqual({ ok: true });
    expect(await res.text()).toBe('{"ok":true}'); // original body still readable for the client
  });
});
