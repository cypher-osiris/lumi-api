/**
 * Private request log for the owner (GET /v1/owner/traffic): path, status, UA class, Referer host, country and a
 * daily-rotating keyed IP hash. Raw IPs, query strings, Authorization and other headers are never stored.
 * Logging is best-effort (waitUntil) and never affects a response.
 */
import type { D1Like } from "./config";

export interface TrafficRow {
  ts: number;
  day: string;
  method: string;
  path: string;
  status: number;
  ua: string | null;
  ua_class: string;
  ref_host: string | null;
  ip_hash: string | null;
  country: string | null;
  is_402: boolean;
  paid: boolean;
}

export interface TrafficStore {
  insert(row: TrafficRow): Promise<void>;
  since(tsMs: number, limit: number): Promise<TrafficRow[]>;
  prune(beforeMs: number): Promise<void>;
}

export const TRAFFIC_RETENTION_DAYS = 90;

/** Rough client class from the User-Agent. */
export function uaClass(ua: string | null | undefined): string {
  const u = (ua ?? "").toLowerCase();
  if (!u) return "other";
  if (/gptbot|chatgpt|oai-searchbot|claude|anthropic|perplexity|bytespider|ccbot|cohere|google-extended|meta-externalagent|amazonbot|applebot-extended|mistral|grok|xai|youbot|duckassist/.test(u)) return "ai-agent";
  if (/mcp|x402|axios|node-fetch|undici|python-requests|python-httpx|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|got \(|ky\/|deno|bun\//.test(u) || /^node$/.test(u)) return "sdk";
  if (/curl|wget|httpie|postman|insomnia/.test(u)) return "cli";
  if (/bot|crawler|spider|crawl|slurp|facebookexternalhit|preview|monitor|uptime|scan|headless|lighthouse|python|scrapy/.test(u)) return "bot";
  if (/mozilla\/|safari|chrome|firefox|edg\//.test(u)) return "browser";
  return "other";
}

/** Pathname with secrets stripped: /mcp/<owner key> becomes /mcp/:key. Capped at 200 chars. */
export function safePath(pathname: string): string {
  const p = pathname.startsWith("/mcp/") ? "/mcp/:key" : pathname;
  return p.slice(0, 200);
}

function refHost(ref: string | null): string | null {
  if (!ref) return null;
  try { return new URL(ref).hostname.slice(0, 120) || null; } catch { return null; }
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the log row for one request/response pair. `secret` keys the IP hash (no secret = no hash). */
export async function trafficRow(request: Request, response: Response, secret: string | undefined, now: number): Promise<TrafficRow> {
  const url = new URL(request.url);
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null;
  const ua = request.headers.get("User-Agent");
  const cf = (request as unknown as { cf?: { country?: string } }).cf;
  return {
    ts: now,
    day,
    method: request.method.slice(0, 10),
    path: safePath(url.pathname),
    status: response.status,
    ua: ua ? ua.slice(0, 160) : null,
    ua_class: uaClass(ua),
    ref_host: refHost(request.headers.get("Referer")),
    ip_hash: ip && secret ? await hmacHex(secret, `traffic|${day}|${ip}`) : null,
    country: cf?.country ?? null,
    is_402: response.status === 402,
    paid: response.status < 400 && response.headers.has("PAYMENT-RESPONSE"),
  };
}

export class MemoryTrafficStore implements TrafficStore {
  rows: TrafficRow[] = [];
  async insert(row: TrafficRow) { this.rows.push(row); }
  async since(tsMs: number, limit: number) { return this.rows.filter((r) => r.ts >= tsMs).sort((a, b) => b.ts - a.ts).slice(0, limit); }
  async prune(beforeMs: number) { this.rows = this.rows.filter((r) => r.ts >= beforeMs); }
}

export class D1TrafficStore implements TrafficStore {
  constructor(private db: D1Like) {}
  async insert(r: TrafficRow) {
    await this.db
      .prepare("INSERT INTO traffic (ts, day, method, path, status, ua, ua_class, ref_host, ip_hash, country, is_402, paid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(r.ts, r.day, r.method, r.path, r.status, r.ua, r.ua_class, r.ref_host, r.ip_hash, r.country, r.is_402 ? 1 : 0, r.paid ? 1 : 0)
      .run();
  }
  async since(tsMs: number, limit: number) {
    const out = await this.db
      .prepare("SELECT ts, day, method, path, status, ua, ua_class, ref_host, ip_hash, country, is_402, paid FROM traffic WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
      .bind(tsMs, limit)
      .all<Record<string, unknown>>();
    return (out.results ?? []).map((x) => ({ ...(x as unknown as TrafficRow), is_402: Number(x.is_402) === 1, paid: Number(x.paid) === 1 }));
  }
  async prune(beforeMs: number) {
    await this.db.prepare("DELETE FROM traffic WHERE ts < ?").bind(beforeMs).run();
  }
}

const top = (rows: TrafficRow[], key: (r: TrafficRow) => string | null, n: number) => {
  const m = new Map<string, { requests: number; visitors: Set<string> }>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const e = m.get(k) ?? { requests: 0, visitors: new Set<string>() };
    e.requests++;
    if (r.ip_hash) e.visitors.add(`${r.day}|${r.ip_hash}`);
    m.set(k, e);
  }
  return [...m.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, n).map(([k, v]) => ({ key: k, requests: v.requests, visitor_days: v.visitors.size }));
};

/** Owner summary over the last `days` (1-90) days. */
export async function trafficSummary(store: TrafficStore, now: number, days: number) {
  const d = Math.max(1, Math.min(TRAFFIC_RETENTION_DAYS, Math.floor(days) || 7));
  const startDay = new Date(now - (d - 1) * 86_400_000).toISOString().slice(0, 10);
  const since = Date.parse(`${startDay}T00:00:00Z`);
  const LIMIT = 100_000;
  const rows = await store.since(since, LIMIT);
  const daily = new Map<string, { requests: number; visitors: Set<string>; r402: number; paid: number; browser: number; bots: number }>();
  for (let t = since; t <= now; t += 86_400_000) daily.set(new Date(t).toISOString().slice(0, 10), { requests: 0, visitors: new Set(), r402: 0, paid: 0, browser: 0, bots: 0 });
  for (const r of rows) {
    const e = daily.get(r.day) ?? { requests: 0, visitors: new Set<string>(), r402: 0, paid: 0, browser: 0, bots: 0 };
    e.requests++;
    if (r.ip_hash) e.visitors.add(r.ip_hash);
    if (r.is_402) e.r402++;
    if (r.paid) e.paid++;
    if (r.ua_class === "browser") e.browser++;
    else e.bots++;
    daily.set(r.day, e);
  }
  const paidRows = rows.filter((r) => r.paid);
  const r402 = rows.filter((r) => r.is_402);
  return {
    kind: "owner_traffic",
    generated_at: new Date(now).toISOString(),
    window: { days: d, from: startDay, to: new Date(now).toISOString().slice(0, 10) },
    truncated: rows.length >= LIMIT,
    privacy: "No raw IPs are stored: visitors are counted with a daily-rotating keyed hash. Pathnames only (no query strings); /mcp/<key> is stored as /mcp/:key.",
    totals: {
      requests: rows.length,
      visitor_days: new Set(rows.filter((r) => r.ip_hash).map((r) => `${r.day}|${r.ip_hash}`)).size,
      payment_required_402: r402.length,
      paid: paidRows.length,
      paid_per_402: r402.length ? Number((paidRows.length / r402.length).toFixed(4)) : null,
      by_status: Object.fromEntries(top(rows, (r) => String(r.status), 20).map((x) => [x.key, x.requests])),
      by_client: Object.fromEntries(top(rows, (r) => r.ua_class, 10).map((x) => [x.key, x.requests])),
    },
    daily: [...daily.entries()].sort().map(([day, e]) => ({ day, requests: e.requests, visitors: e.visitors.size, payment_required_402: e.r402, paid: e.paid, browser: e.browser, non_browser: e.bots })),
    top_paths: top(rows, (r) => r.path, 25),
    top_402_paths: top(r402, (r) => r.path, 15),
    top_paid_paths: top(paidRows, (r) => r.path, 15),
    top_user_agents: top(rows, (r) => (r.ua ? `${r.ua_class}: ${r.ua}` : null), 25),
    top_referrers: top(rows, (r) => r.ref_host, 20),
    top_countries: top(rows, (r) => r.country, 20),
  };
}
