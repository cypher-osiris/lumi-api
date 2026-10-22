/** Cloudflare Workers entry point. */
import { createApp, type App } from "./app";
import type { Env } from "./config";

// One app per isolate (keeps the data cache and replay guard warm between requests).
let app: App | undefined;
let appEnv: Env | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!app || appEnv !== env) {
      app = createApp(env);
      appEnv = env;
    }
    return app.fetch(request);
  },
};

export { InvoiceGuard } from "./invoice-guard";
