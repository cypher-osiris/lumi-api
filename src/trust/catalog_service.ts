/** Catalog orchestration: cron scheduling, queue consumer, lookups and owner-posted purchase evidence. */
import type { D1Like } from "../config";
import { VENDORS } from "../vendors";
import {
  DISCOVERY_URL, INGEST_PAGE, PROBE_BATCH, RDAP_PER_BATCH, RUNS_PER_DAY, DELISTED_AFTER_MS, LABELS, LABEL_NOTES,
  toListing, probeRow, rdapRegistered, catalogView, normalizeDomain, normalizeUrl, isPlatformHost, explorerFor,
  type CatalogStore, type CatalogStats, type LookupQuery, type BuyRow,
} from "./catalog";
import { lookupBaseUsdc, lookupXrplPayment, EVM_TX_RE, XRPL_TX_RE } from "./verify";

export type CatalogJob = { kind: "ingest"; offset: number } | { kind: "probe"; after: number };
export interface QueueLike {
  sendBatch(messages: { body: CatalogJob; delaySeconds?: number }[]): Promise<unknown>;
}

export interface SelfEntry {
  name: string;
  domains: string[];
  pay_to: string[];
  url: string;
}

export interface CatalogDeps {
  store: CatalogStore;
  fetch: typeof fetch;
  now: () => number;
  log(e: Record<string, unknown>): void;
  queue?: QueueLike;
  xrplRpc: string[];
  baseRpc: string;
  buyers: { xrpl: string[]; evm: string[] };
  self: SelfEntry;
  isOwner(request: Request): Promise<boolean>;
}

const STATS_EVERY_MS = 6 * 3_600_000;
/** D1 Free allows 100k rows written per day (index entries count). Catalog work stays well under it. */
export const WRITE_BUDGET = { ingest: 55_000, probe: 85_000 };
const PER_HOST = 3;
/** CDP discovery rate-limits bursts (HTTP 429 seen from Workers): one page per 10 s. */
const INGEST_SPACING_S = 10;
const PROBE_SPACING_S = 30;
const dayKey = (t: number) => "writes:" + new Date(t).toISOString().slice(0, 10);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...headers } });
const iso = (t: number) => new Date(t).toISOString();
const BANNED = /\b(scam|fraud|rug|fake|ponzi|steal|thief|criminal)\b/i;

export function createCatalog(deps: CatalogDeps) {
  const { store, now } = deps;

  /** Jobs are spaced `spacing` seconds apart (queue delay) so upstream APIs and vendors see a slow, steady rate. */
  async function send(jobs: CatalogJob[], spacing = 0) {
    if (!jobs.length) return;
    if (!deps.queue) {
      for (const j of jobs) await consume(j); // tests / Node: run inline
      return;
    }
    const msgs = jobs.map((body, i) => (spacing && i ? { body, delaySeconds: Math.min(43_200, i * spacing) } : { body }));
    for (let i = 0; i < msgs.length; i += 100) await deps.queue.sendBatch(msgs.slice(i, i + 100));
  }

  async function catalogTotal(): Promise<number> {
    const r = await deps.fetch(`${DISCOVERY_URL}?limit=1&offset=0`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`discovery HTTP ${r.status}`);
    const total = Number(((await r.json()) as any).pagination?.total ?? 0);
    await store.setMeta("ingest_total", String(total));
    return total;
  }

  /** Owner-triggered full pass: every page at once (still bounded by the daily write budget). */
  async function startIngest(): Promise<number> {
    const total = await catalogTotal();
    const jobs: CatalogJob[] = [];
    for (let o = 0; o < total + INGEST_PAGE; o += INGEST_PAGE) jobs.push({ kind: "ingest", offset: o });
    await store.setMeta("ingest_last", JSON.stringify({ at: now(), total, pages: jobs.length }));
    await send(jobs, INGEST_SPACING_S);
    return total;
  }

  /**
   * Every 30 min (cron): the next slice of the Bazaar catalog (the whole list is re-read about once a day),
   * the next slice of free quote checks (rotating slices; coverage depends on catalog size), and stats every 6 h.
   */
  async function cron() {
    const t = now();
    const out: Record<string, unknown> = {};
    try {
      let total = Number((await store.getMeta("ingest_total")) ?? "0");
      let cursor = Number((await store.getMeta("ingest_cursor")) ?? "0");
      if (!total || cursor >= total) {
        if (total) await store.setMeta("ingest_last", JSON.stringify({ at: t, total, pages: Math.ceil(total / INGEST_PAGE) }));
        total = await catalogTotal();
        cursor = 0;
      }
      const pages = Math.max(1, Math.ceil(total / INGEST_PAGE / RUNS_PER_DAY));
      const jobs: CatalogJob[] = [];
      for (let i = 0; i < pages && cursor < total; i++, cursor += INGEST_PAGE) jobs.push({ kind: "ingest", offset: cursor });
      await store.setMeta("ingest_cursor", String(cursor));
      await send(jobs, INGEST_SPACING_S);
      out.ingest_jobs = jobs.length;
    } catch (e) {
      out.ingest_error = String(e);
    }
    const maxId = await store.maxId();
    if (maxId > 0) {
      const perRun = Math.max(1, Math.ceil(maxId / PROBE_BATCH / RUNS_PER_DAY));
      let cursor = Number((await store.getMeta("probe_cursor")) ?? "0");
      const jobs: CatalogJob[] = [];
      for (let i = 0; i < perRun; i++) {
        if (cursor >= maxId) cursor = 0;
        jobs.push({ kind: "probe", after: cursor });
        cursor += PROBE_BATCH;
      }
      await store.setMeta("probe_cursor", String(cursor));
      await send(jobs, PROBE_SPACING_S);
      out.probe_jobs = jobs.length;
    }
    const st = await stats();
    if (!st || t - st.computed_at > STATS_EVERY_MS) await store.setMeta("stats", JSON.stringify(await store.computeStats(t)));
    deps.log({ event: "catalog_cron", ...out });
    return out;
  }

  async function underBudget(kind: keyof typeof WRITE_BUDGET) {
    const used = Number((await store.getMeta(dayKey(now()))) ?? "0");
    return used < WRITE_BUDGET[kind];
  }

  async function probeAll(rows: Awaited<ReturnType<CatalogStore["range"]>>, t: number) {
    // At most PER_HOST concurrent requests to any one host; hosts run in parallel.
    const byHost = new Map<string, typeof rows>();
    for (const r of rows) byHost.set(r.domain, [...(byHost.get(r.domain) ?? []), r]);
    const out: Awaited<ReturnType<typeof probeRow>>[] = [];
    await Promise.all(
      [...byHost.values()].map(async (list) => {
        for (let i = 0; i < list.length; i += PER_HOST) out.push(...(await Promise.all(list.slice(i, i + PER_HOST).map((r) => probeRow(deps.fetch, r, t)))));
      }),
    );
    return out;
  }

  async function consume(job: CatalogJob) {
    if (job.kind === "ingest") {
      const r = await deps.fetch(`${DISCOVERY_URL}?limit=${INGEST_PAGE}&offset=${job.offset}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`discovery HTTP ${r.status}`);
      const items: any[] = ((await r.json()) as any).items ?? [];
      const ls = items.map(toListing).filter((x): x is NonNullable<typeof x> => !!x);
      if (!(await underBudget("ingest"))) return { skipped: "daily write budget" };
      const w = await store.upsert(ls, now());
      await store.addCounter(dayKey(now()), w + 1);
      return { ingested: ls.length, written: w };
    }
    const t = now();
    if (!(await underBudget("probe"))) return { skipped: "daily write budget" };
    const rows = (await store.range(job.after, PROBE_BATCH)).filter((r) => r.method !== "MCP" && r.last_seen > t - DELISTED_AFTER_MS);
    const results = await probeAll(rows, t);
    const w = await store.saveProbes(results);
    // Domain age: a few registrable domains from this batch that have no recent RDAP answer.
    const regs = [...new Set(rows.map((r) => r.reg_domain).filter((x): x is string => !!x && !isPlatformHost(x)))];
    if (regs.length) {
      const known = new Map((await store.domainInfo(regs)).map((x) => [x.domain, x]));
      const due = regs.filter((x) => { const k = known.get(x); return !k || k.checked_at < t - 30 * 86_400_000; }).slice(0, RDAP_PER_BATCH);
      for (const dmn of due) {
        const r = await rdapRegistered(deps.fetch, dmn);
        await store.saveDomain({ domain: dmn, registered_at: r.registered_at, checked_at: t, error: r.error });
      }
      await store.addCounter(dayKey(t), w + due.length * 2 + 1);
    } else await store.addCounter(dayKey(t), w + 1);
    return { probed: results.length, valid: results.filter((r) => r.valid).length };
  }

  async function stats(): Promise<CatalogStats | null> {
    const s = await store.getMeta("stats");
    try { return s ? (JSON.parse(s) as CatalogStats) : null; } catch { return null; }
  }

  function selfMatch(q: LookupQuery): boolean {
    const s = deps.self;
    if (q.domain && s.domains.includes(normalizeDomain(q.domain))) return true;
    if (q.url) { const n = normalizeUrl(q.url); if (n && s.domains.includes(normalizeDomain(new URL(n).hostname))) return true; }
    if (q.payTo && s.pay_to.map((x) => x.toLowerCase()).includes(q.payTo.trim().toLowerCase())) return true;
    return false;
  }

  function curatedMatches(q: LookupQuery, base: string) {
    const d = q.domain ? normalizeDomain(q.domain) : q.url && normalizeUrl(q.url) ? normalizeDomain(new URL(normalizeUrl(q.url)!).hostname) : null;
    const pt = q.payTo?.trim().toLowerCase();
    return VENDORS.filter((v) => {
      const hosts = [v.homepage, ...v.endpoints.map((e) => e.url)].map((u) => { try { return normalizeDomain(new URL(u).hostname); } catch { return ""; } });
      const pays = [...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])].map((x) => x.toLowerCase());
      return (d && hosts.some((h) => h === d || h.endsWith("." + d))) || (pt && pays.includes(pt));
    }).map((v) => ({ id: v.id, name: v.name, homepage: v.homepage, tier: "purchase-verified (curated XRPL list, scored)", detail: `${base}/v1/trust/vendors/${v.id}` }));
  }

  async function lookupDoc(q: LookupQuery, base: string, limit = 25) {
    const query = Object.fromEntries(Object.entries(q).filter(([, v]) => v));
    const t = now();
    if (selfMatch(q)) {
      return {
        kind: "trust_lookup", query, observed: true, generated_at: iso(t),
        self: { name: deps.self.name, url: deps.self.url, label: LABELS.self, note: "This is Lumi's own API. Lumi does not score or quote-check itself." },
      };
    }
    const curated = curatedMatches(q, base);
    const { total, rows } = await store.lookup(q, limit);
    const buys = await store.buysFor(rows.map((r) => r.resource));
    const doms = new Map((await store.domainInfo([...new Set(rows.map((r) => r.reg_domain).filter((x): x is string => !!x))])).map((x) => [x.domain, x]));
    const entries = rows.map((r) => catalogView(r, buys.filter((b) => b.resource === r.resource), r.reg_domain ? doms.get(r.reg_domain) : undefined, t));
    if (!curated.length && !entries.length) {
      return {
        kind: "trust_lookup", query, observed: false, generated_at: iso(t),
        note: "Lumi has no observations for this URL, domain or payTo. It is not in the CDP x402 Bazaar catalog Lumi ingests (refreshed daily) nor in Lumi's curated list. No observation is not a negative signal.",
      };
    }
    const tiers: Record<string, number> = {};
    for (const e of entries) tiers[e.tier] = (tiers[e.tier] ?? 0) + 1;
    const st = await stats();
    return {
      kind: "trust_lookup", query, observed: true, generated_at: iso(t),
      ...(st ? { coverage: coverageLine(st) } : {}),
      labels: LABEL_NOTES,
      curated,
      catalog: { total_matches: total, shown: entries.length, ordering: "Bazaar 30-day calls, most used first", tiers_shown: tiers, entries },
      methodology: `${base}/v1/trust/methodology`,
      note: "Observations, not a rating. Quote checks are free unpaid requests; purchases are single test-buys. Few samples = low confidence.",
    };
  }

  async function summary(base: string) {
    const s = await stats();
    const ing = await store.getMeta("ingest_last");
    return {
      source: "CDP x402 Bazaar discovery (free); x402scan's resource API is paid, so it is not ingested",
      lookup: `${base}/v1/trust/vendors?url=<resource url> | ?domain=<host> | ?payTo=<address>`,
      browse: `${base}/v1/trust/catalog`,
      labels: LABEL_NOTES,
      coverage: s ? coverageLine(s) : null,
      counts: s ? { catalogued: s.catalogued, active: s.active, quote_checked: s.quote_checked, quote_checked_24h: s.quote_checked_24h, quote_verified: s.quote_verified, purchase_verified: s.purchase_verified, test_buys: s.test_buys, domains: s.domains, as_of: iso(s.computed_at) } : null,
      last_ingest: ing ? (() => { const j = JSON.parse(ing); return { at: iso(j.at), listed_total: j.total }; })() : null,
      checks: "free, unpaid 402-quote checks rotate through the catalog in slices every 30 minutes (valid 402, price vs listing, payTo vs listing, latency); counts.quote_checked_24h shows how many resources were actually checked in the last 24 h. Registrable-domain age via RDAP monthly",
    };
  }

  async function browseDoc(url: URL, base: string) {
    const t = now();
    const popular = url.searchParams.get("popular") === "1";
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50") || 50));
    let rows;
    if (popular) {
      const maxUsd = Math.min(1, Number(url.searchParams.get("max_usd") ?? "0.05") || 0.05);
      rows = await store.popular(maxUsd, limit, url.searchParams.get("network") ?? "eip155:8453");
    } else {
      rows = await store.range(Math.max(0, Number(url.searchParams.get("after") ?? "0") || 0), limit);
    }
    const buys = await store.buysFor(rows.map((r) => r.resource));
    return {
      kind: "trust_catalog", generated_at: iso(t), summary: await summary(base),
      entries: rows.map((r) => ({ id: r.id, ...catalogView(r, buys.filter((b) => b.resource === r.resource), undefined, t) })),
      next: popular || rows.length < limit ? null : `${base}/v1/trust/catalog?after=${rows[rows.length - 1]?.id ?? 0}&limit=${limit}`,
    };
  }

  async function postObservation(request: Request): Promise<Response> {
    if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    let b: any;
    try { b = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
    const resource = typeof b?.resource === "string" ? normalizeUrl(b.resource) : null;
    const row = resource ? await store.byResource(resource) : null;
    if (!row) return json(404, { error: "unknown_resource", detail: "resource must be a catalogued URL (GET /v1/trust/vendors?url=...)" });
    const network = String(b.network ?? "");
    let tx = typeof b.tx_hash === "string" ? b.tx_hash.trim() : "";
    if (network === "eip155:8453") { tx = tx.toLowerCase(); if (!EVM_TX_RE.test(tx)) return json(400, { error: "invalid_field", field: "tx_hash" }); }
    else if (network === "xrpl:0") { tx = tx.toUpperCase(); if (!XRPL_TX_RE.test(tx)) return json(400, { error: "invalid_field", field: "tx_hash" }); }
    else return json(400, { error: "invalid_field", field: "network", detail: "eip155:8453 or xrpl:0" });
    if (typeof b.data_returned !== "boolean") return json(400, { error: "invalid_field", field: "data_returned" });
    const summaryText = typeof b.summary === "string" ? b.summary.replace(/\s+/g, " ").trim() : "";
    if (!summaryText || summaryText.length > 300) return json(400, { error: "invalid_field", field: "summary", detail: "1-300 chars" });
    if (BANNED.test(summaryText)) return json(400, { error: "invalid_field", field: "summary", detail: "factual wording only" });
    const look = network === "eip155:8453" ? await lookupBaseUsdc(deps.fetch, deps.baseRpc, tx) : await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (!look.ok) return json(look.reason === "ledger_unavailable" ? 503 : 422, { recorded: false, reason: look.reason });
    const buyers = (network === "eip155:8453" ? deps.buyers.evm : deps.buyers.xrpl).map((x) => x.toLowerCase());
    const listed = (row.pay_tos ?? "").split(",");
    const pay = look.payments.find((p) => buyers.includes(p.from.toLowerCase()) && listed.includes(p.to.toLowerCase()));
    if (!pay) return json(422, { recorded: false, reason: "no payment from a Lumi wallet to a listed payTo in this tx" });
    const http = b.http_status == null ? null : Number(b.http_status);
    const lat = b.latency_ms == null ? null : Number(b.latency_ms);
    const buy: BuyRow = {
      resource: row.resource, domain: row.domain, ts: Number.isFinite(pay.ts) ? pay.ts : now(), network, tx_hash: tx, amount: pay.amount, asset: pay.asset,
      pay_to: pay.to, facilitator: typeof b.facilitator === "string" ? b.facilitator.slice(0, 80) : null,
      http_status: Number.isInteger(http) ? http : null, data_returned: b.data_returned, latency_ms: Number.isInteger(lat) ? lat : null, summary: summaryText,
    };
    const ins = await store.addBuy(buy);
    deps.log({ event: "catalog_buy", domain: row.domain, inserted: ins === "inserted" });
    return json(ins === "inserted" ? 201 : 200, { recorded: ins === "inserted", duplicate: ins === "duplicate", tx_hash: tx, explorer: explorerFor(network, tx) });
  }

  async function handle(request: Request, url: URL, base: string): Promise<Response | null> {
    const path = url.pathname;
    if (request.method === "GET" && path === "/v1/trust/catalog") return json(200, await browseDoc(url, base), { "Cache-Control": "public, max-age=300" });
    if (request.method === "POST" && path === "/v1/trust/catalog/observations") return postObservation(request);
    if (request.method === "POST" && path === "/v1/trust/catalog/ingest") {
      if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      if (url.searchParams.get("now") === "1") return json(200, { started: true, total: await startIngest() });
      return json(202, { requested: false, detail: "Not needed: the 30-minute cron runs a rolling ingest that covers the full catalog daily. Use ?now=1 to queue every page immediately." });
    }
    if (request.method === "POST" && path === "/v1/trust/catalog/stats") {
      if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      const s = await store.computeStats(now());
      await store.setMeta("stats", JSON.stringify(s));
      return json(200, s);
    }
    return null;
  }

  return { cron, consume, lookupDoc, summary, handle, startIngest, stats };
}

export type Catalog = ReturnType<typeof createCatalog>;
export type { D1Like };

const fmt = (n: number) => Number(n ?? 0).toLocaleString("en-US");
/** Honest one-line coverage: what is indexed vs what Lumi actually checked or bought. */
export function coverageLine(s: { catalogued: number; domains: number; quote_verified: number; purchase_verified: number; quote_checked_24h?: number }): string {
  return `${fmt(s.catalogued)} resources across ${fmt(s.domains)} domains indexed, ${fmt(s.quote_verified)} quote-verified, ${fmt(s.purchase_verified)} purchase-verified` +
    (s.quote_checked_24h != null ? ` (${fmt(s.quote_checked_24h)} quote-checked in the last 24 h)` : "");
}
