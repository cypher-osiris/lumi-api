/** Cloudflare Workers entry point. */
import { createApp, type App } from "./app";
import type { Env } from "./config";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return appFor(env).fetch(request);
  },
  /** Cron trigger (every 30 min): free, unpaid 402-quote probes of the trust allowlist. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(appFor(env).scheduled().catch((e) => console.error(JSON.stringify({ event: "trust_probe_error", error: String(e) }))));
  },
};

export { InvoiceGuard } from "./invoice-guard";
