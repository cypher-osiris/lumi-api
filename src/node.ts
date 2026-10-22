/**
 * Plain Node.js server (no wrangler needed): `npm start`.
 * Reads config from process.env (and .dev.vars / .env if present).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "./app";
import type { Env } from "./config";

export function loadDotVars(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function startServer(env: Env, port: number, host = "127.0.0.1"): Promise<{ server: Server; url: string }> {
  const app = createApp(env);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const response = await app.fetch(new Request(url, { method: req.method, headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${actual}` });
    });
  });
}

const isMain = process.argv[1] && /node\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const env: Env = { ...loadDotVars(".dev.vars"), ...(process.env as Env) };
  const port = Number(process.env.PORT || 8787);
  startServer(env, port, process.env.HOST || "127.0.0.1").then(({ url }) => {
    const app = createApp(env);
    console.log(`Lumi API listening on ${url}  (network ${app.config.network}, payTo ${app.config.payTo})`);
  });
}
