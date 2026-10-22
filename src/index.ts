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

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    const cache = request.method === "GET" && !request.headers.has("Authorization") && EDGE_CACHED.test(url.pathname) ? edgeCache() : undefined;
    if (cache) {
      const hit = await cache.match(request).catch(() => undefined);
      if (hit) return hit;
    }
    const res = await appFor(env).fetch(request, ctx);
    if (cache && res.status === 200 && /public, max-age=\d+/.test(res.headers.get("Cache-Control") ?? "")) {
      ctx.waitUntil(cache.put(request, res.clone()).catch(() => {}));
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
