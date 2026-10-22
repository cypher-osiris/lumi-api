/** Cloudflare Workers entry point. */
import { createApp, type App } from "./app";
import type { Env } from "./config";
import type { CatalogJob } from "./trust/catalog_service";

// One app per isolate (keeps the data cache and replay guard warm between requests).
let app: App | undefined;
let appEnv: Env | undefined;

function appFor(env: Env): App {
  if (!app || appEnv !== env) {
    app = createApp(env);
    appEnv = env;
  }
  return app;
}

/** Free, public, read-only documents served from the Cloudflare edge cache (TTL = their Cache-Control max-age). */
const EDGE_CACHED = /^\/v1\/(samples|trust\/vendors|trust\/catalog|trust\/methodology)$/;

function edgeCache(): Cache | undefined {
  return (globalThis as any).caches?.default as Cache | undefined;
}

/** Header that keeps the app's own Cache-Control on the stored copy. Cloudflare's zone "Browser Cache TTL" (4 h by default)
 * rewrites Cache-Control on Cache-API hits, which would let clients keep trust lookups for 4 h instead of 5 min. */
const ORIGIN_CC = "X-Lumi-Cache-Control";

/** A cache hit with the app's original Cache-Control restored (and the helper header dropped). */
export function restoreHit(hit: Response): Response {
  const h = new Headers(hit.headers);
  const cc = h.get(ORIGIN_CC);
  if (cc) h.set("Cache-Control", cc);
  h.delete(ORIGIN_CC);
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
}

/** The copy stored in the edge cache: the same response plus the helper header. */
export function storable(res: Response): Response {
  const h = new Headers(res.headers);
  h.set(ORIGIN_CC, res.headers.get("Cache-Control") ?? "");
  return new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    const cache = request.method === "GET" && !request.headers.has("Authorization") && EDGE_CACHED.test(url.pathname) ? edgeCache() : undefined;
    if (cache) {
      const hit = await cache.match(request).catch(() => undefined);
      if (hit) {
        const out = restoreHit(hit);
        appFor(env).logTraffic(request, out, ctx);
        return out;
      }
    }
    const res = await appFor(env).fetch(request, ctx);
    appFor(env).logTraffic(request, res, ctx);
    if (cache && res.status === 200 && /public, max-age=\d+/.test(res.headers.get("Cache-Control") ?? "")) {
      ctx.waitUntil(cache.put(request, storable(res)).catch(() => {}));
    }
    return res;
  },
  /** Cron trigger (every 30 min): free, unpaid 402-quote probes of the trust allowlist; schedules catalog jobs. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(appFor(env).scheduled().catch((e) => console.error(JSON.stringify({ event: "trust_probe_error", error: String(e) }))));
  },
  /** Queue consumer (lumi-trust-jobs, batch size 1): one catalog ingest page or one quote-check slice per invocation. */
  async queue(batch: { messages: { body: CatalogJob; ack(): void; retry(o?: { delaySeconds?: number }): void }[] }, env: Env): Promise<void> {
    const a = appFor(env);
    for (const m of batch.messages) {
      try {
        await a.queue(m.body);
        m.ack();
      } catch (e) {
        console.error(JSON.stringify({ event: "catalog_job_error", kind: m.body?.kind, error: String(e) }));
        m.retry({ delaySeconds: /\b429\b/.test(String(e)) ? 300 + Math.floor(Math.random() * 600) : 60 });
      }
    }
  },
};

export { InvoiceGuard } from "./invoice-guard";
