/** Seller monitoring + data licence feed. */
import { createMonitor, MONITOR_POST_PATHS } from "./monitor";
import { createFeed, FEED_POST_PATHS } from "./feed";
import { POST_CORS, type CommerceDeps, type WaitUntil } from "./common";

export type { CommerceDeps } from "./common";
export { MemoryCommerceStore, D1CommerceStore } from "./store";

export function createCommerce(deps: CommerceDeps) {
  const monitor = createMonitor(deps);
  const feed = createFeed(deps, monitor.relationships);
  const postPaths = [...MONITOR_POST_PATHS, ...FEED_POST_PATHS];

  async function handle(request: Request, path: string, base: string, ctx?: WaitUntil): Promise<Response | null> {
    const isMonitor = path === "/v1/monitor" || path.startsWith("/v1/monitor/") || path.startsWith("/v1/owner/monitor") || path === "/v1/owner/corrections";
    const isFeed = path === "/v1/feed" || path.startsWith("/v1/feed/") || path === "/v1/owner/feed";
    if (!isMonitor && !isFeed) return null;
    const url = new URL(request.url);
    let r: Response | null;
    try {
      r = isMonitor ? await monitor.handle(request, path, url, base, ctx) : await feed.handle(request, path, url, base, ctx);
    } catch (e) {
      deps.log({ event: "commerce_error", path, error: String(e).slice(0, 300) });
      r = new Response(JSON.stringify({ error: "internal_error", note: "Not charged unless a PAYMENT-RESPONSE header is present." }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (!r) return null;
    if (!r.headers.has("Access-Control-Allow-Origin")) {
      const h = new Headers(r.headers);
      for (const [k, v] of Object.entries(POST_CORS)) h.set(k, v);
      h.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
    }
    return r;
  }

  async function cron(base: string) {
    const out: Record<string, unknown> = {};
    try { Object.assign(out, await monitor.cron(base)); } catch (e) { deps.log({ event: "monitor_cron_error", error: String(e).slice(0, 200) }); }
    try { Object.assign(out, await feed.cron()); } catch (e) { deps.log({ event: "feed_cron_error", error: String(e).slice(0, 200) }); }
    return out;
  }

  /** Adds a commercial-relationship disclosure to trust lookups for any payTo that pays Lumi for monitoring. Never alters scores. */
  async function annotate(doc: Record<string, unknown>, payTos: string[]): Promise<Record<string, unknown>> {
    const base = deps.cfg.publicBaseUrl ?? "https://api.lumitrades.io";
    if (!payTos.length) return doc;
    const rel = await monitor.relationships(payTos, base);
    if (!rel.size) return doc;
    return { ...doc, commercial_relationship: [...rel.values()] };
  }

  return { handle, cron, annotate, postPaths, monitorDoc: monitor.doc, feedDoc: feed.doc };
}
export type Commerce = ReturnType<typeof createCommerce>;
