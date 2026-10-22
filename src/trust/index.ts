/**
 * Trust layer v0: Lumi's automated observations of x402 vendors.
 *
 * - Free, unpaid 402-quote probes every 30 min (cron). No payment is ever sent by the Worker,
 *   and the Worker holds no wallet key.
 * - Paid test-buys are made box-side by the owner and recorded via the owner-only
 *   POST /v1/trust/observations (each tx is checked on-ledger before it is stored).
 * - Agent reports count only when the payment is verified on-ledger AND the payer signed the challenge.
 * - Tips are stored privately; nothing reads them back.
 * Public wording is factual: observed results with timestamps and tx evidence, never a judgement of the business.
 */
import { json } from "../x402";
import { isOwnerKey } from "../mcp";
import { scrubText } from "../sanitize";
import { VENDORS, vendorById, type Vendor, type VendorEndpoint } from "../vendors";
import type { ObservationRow, ProbeRow, ProbeSummary, ReportRow, TrustStore } from "./store";
import {
  lookupXrplPayment, lookupBaseUsdc, verifyXrplSignature, xrplAddressOf, xrplRegularKey, recoverEvmSigner, sha256Hex,
  XRPL_TX_RE, EVM_TX_RE, XRPL_ADDR_RE, EVM_ADDR_RE, RLUSD, USDC_XRPL, type Fetch, type LedgerPayment,
} from "./verify";

export const WINDOW_DAYS = 30;
const DAY = 86_400_000;
export const REPORT_HOLD_MS = DAY;
const REPORT_MAX_AGE_MS = 7 * DAY;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_BODY = 16_384;
export const WEIGHTS = { delivery: 0.5, uptime: 0.2, latency: 0.15, agent_reports: 0.15 } as const;
export const REPORT_OUTCOMES = ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other"] as const;
export const CONTACT_EMAIL = "hello@lumitrades.io";
const BANNED_WORDS = /\b(scam\w*|fraud\w*|untrustworthy|rip-?off|thie(f|ves)|steal\w*)\b/i;
export const TRUST_POST_PATHS = ["/v1/reports", "/v1/tips", "/v1/trust/replies", "/v1/trust/observations", "/v1/trust/probe"];

export const LABEL =
  "Lumi's automated observations of this x402 endpoint (free 402-quote checks plus small paid test-buys), not a rating or review of the business. Few samples = low confidence.";

export interface TrustDeps {
  store: TrustStore;
  fetch: Fetch;
  now: () => number;
  ownerKey?: string;
  /** HMAC key for salted IP hashes (rate limits). */
  ipSecret: string;
  log: (e: Record<string, unknown>) => void;
  xrplRpc: string[];
  baseRpc: string;
  /** XRPL addresses whose payments are Lumi's own test-buys. */
  buyers: string[];
}

export interface Trust {
  handle(request: Request, path: string, base: string): Promise<Response | null>;
  runProbes(): Promise<{ probes: number; ok: number }>;
  vendorsDoc(base: string): Promise<Record<string, unknown>>;
  vendorDoc(id: string, base: string): Promise<Record<string, unknown> | null>;
}

// ---------------------------------------------------------------- helpers

const iso = (ms: number) => new Date(ms).toISOString();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number | null, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const explorer = (network: string, hash: string) =>
  network.startsWith("eip155:") ? `https://basescan.org/tx/${hash}` : `https://livenet.xrpl.org/transactions/${hash}`;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

function bad(field: string, detail: string): Response {
  return json(400, { error: "invalid_request", field, detail });
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return Array.from(sig.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) return { ok: false, res: json(413, { error: "payload_too_large", max_bytes: MAX_BODY }) };
  const text = await request.text();
  if (text.length > MAX_BODY) return { ok: false, res: json(413, { error: "payload_too_large", max_bytes: MAX_BODY }) };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { ok: true, body };
  } catch {
    return { ok: false, res: json(400, { error: "invalid_json", detail: "Body must be a JSON object." }) };
  }
}

function priceLabel(o: any): { price: string | null; asset: string | null } {
  if (!o) return { price: null, asset: null };
  if (o.asset === "XRP") return { price: /^\d+$/.test(String(o.amount)) ? String(Number(o.amount) / 1e6) : String(o.amount), asset: "XRP" };
  const issuer = o.extra?.issuer ?? o.issuer;
  if (o.asset === RLUSD.currency && issuer === RLUSD.issuer) return { price: String(o.amount), asset: "RLUSD" };
  if (o.asset === USDC_XRPL.currency && issuer === USDC_XRPL.issuer) return { price: String(o.amount), asset: "USDC" };
  return { price: String(o.amount), asset: String(o.asset).slice(0, 48) };
}

function decodeB64Json(h: string): any {
  const bin = atob(h.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

// ---------------------------------------------------------------- scoring

export interface ScoreResult {
  value: number | null;
  confidence: "low" | "medium" | "high";
  components: Record<string, unknown>;
  samples: { paid_test_buys: number; delivered: number; probes: number; probes_ok: number; verified_reports_counted: number };
}

export function scoreVendor(probes: ProbeSummary, obs: ObservationRow[], reports: ReportRow[], now: number): ScoreResult {
  const paid = obs.length;
  const delivered = obs.filter((o) => o.data_returned).length;
  const delivery = paid ? delivered / paid : null;
  const uptime = probes.n ? probes.ok / probes.n : null;
  const med = median(probes.latencies);
  const latency = med == null ? null : clamp01(1 - (med - 500) / 4500);

  // Agent reports: verified, past the hold, max 1 per reporter per UTC day, max 5 per reporter per window.
  const perDay = new Set<string>();
  const perReporter = new Map<string, number>();
  let pos = 0;
  let neg = 0;
  let counted = 0;
  for (const r of [...reports].sort((a, b) => a.ts - b.ts)) {
    if (!r.verified || r.ts > now - REPORT_HOLD_MS) continue;
    const dayKey = `${r.reporter}:${new Date(r.ts).toISOString().slice(0, 10)}`;
    if (perDay.has(dayKey)) continue;
    if ((perReporter.get(r.reporter) ?? 0) >= 5) continue;
    perDay.add(dayKey);
    perReporter.set(r.reporter, (perReporter.get(r.reporter) ?? 0) + 1);
    counted++;
    if (r.outcome === "delivered") {
      pos += 1;
    } else {
      const t = r.tx_ts ?? r.ts;
      const corroborated = obs.some((o) => !o.data_returned && Math.abs(o.ts - t) <= 6 * 3_600_000);
      neg += corroborated ? 1.5 : 1;
    }
  }
  const agentReports = pos + neg > 0 ? pos / (pos + neg) : null;

  const parts: [keyof typeof WEIGHTS, number | null][] = [
    ["delivery", delivery],
    ["uptime", uptime],
    ["latency", latency],
    ["agent_reports", agentReports],
  ];
  let num = 0;
  let den = 0;
  for (const [k, v] of parts) if (v != null) { num += WEIGHTS[k] * v; den += WEIGHTS[k]; }
  const value = den ? Math.round((100 * num) / den) : null;
  const confidence = paid < 5 || probes.n < 10 ? "low" : paid < 20 ? "medium" : "high";
  return {
    value,
    confidence,
    components: {
      delivery: { value: round(delivery), weight: WEIGHTS.delivery, delivered, paid_test_buys: paid, meaning: "share of Lumi's paid test-buys whose response contained data" },
      uptime: { value: round(uptime), weight: WEIGHTS.uptime, valid_quotes: probes.ok, probes: probes.n, meaning: "share of free probes that got a valid x402 402 quote with an XRPL option to a listed address" },
      latency: { value: round(latency), weight: WEIGHTS.latency, median_ms: med == null ? null : Math.round(med), samples: probes.latencies.length, meaning: "median time to a valid 402 quote; 500 ms or less = 1, 5 s or more = 0" },
      agent_reports: { value: round(agentReports), weight: WEIGHTS.agent_reports, counted, meaning: "verified agent reports (on-ledger payment + payer signature), after a 24 h hold; excluded when there are none" },
    },
    samples: { paid_test_buys: paid, delivered, probes: probes.n, probes_ok: probes.ok, verified_reports_counted: counted },
  };
}

// ---------------------------------------------------------------- docs

export function methodologyDoc(base: string) {
  return {
    kind: "trust_methodology",
    version: "v0",
    url: `${base}/v1/trust/methodology`,
    label: LABEL,
    what_is_measured: [
      "Free probes: every 30 minutes Lumi sends one unpaid request to each listed endpoint and records whether it answers with a valid x402 v2 402 quote that offers an XRPL (xrpl:0) option paying an address listed for that vendor, the quoted price and asset, whether the quote carries a sourceTag, and the response time. Probes never send a payment.",
      "Paid test-buys: Lumi buys one call per vendor per day from its own XRPL wallet (hard caps: 0.15 RLUSD + 0.05 XRP per day in total, and no endpoint priced above 0.05). Each record shows the amount, asset, ledger tx hash, HTTP status, whether the response contained data, and latency. Every test-buy tx is checked on the XRPL ledger before it is stored.",
      "Agent reports: any agent that paid a listed vendor can POST /v1/reports. A report counts only if the payment is validated on-ledger (tesSUCCESS, sent by the reporter, delivered to a pay-to address listed for that vendor, within the last 7 days) AND the payer signs the challenge `lumi-report:<network>:<tx_hash>`. Unverified submissions are stored privately for abuse review and are never shown or scored.",
    ],
    score: {
      range: "0-100, over the last 30 days",
      weights: WEIGHTS,
      formula: "weighted mean of the components that have data (a component with no data is left out and the weights are renormalised)",
      delivery: "delivered / paid test-buys",
      uptime: "valid 402 quotes / probes",
      latency: "1 - (median_ms - 500) / 4500, clipped to 0..1",
      agent_reports: "positive / (positive + negative) verified reports; a negative report gets weight 1.5 when a Lumi test-buy within 6 h also returned no data; max 1 counted report per reporter per day and 5 per 30 days; 24 h hold before counting",
      confidence: "low when there are fewer than 5 paid test-buys or fewer than 10 probes; medium below 20 paid test-buys; otherwise high",
      ordering: "vendors are listed in allowlist order, not ranked",
    },
    data_returned_rule:
      "A response 'contained data' when the HTTP status is 2xx and the body has non-empty content for that endpoint (e.g. a non-empty result list). Error bodies, empty lists and empty objects count as no data.",
    right_to_reply: rightToReply(base),
    reports: {
      endpoint: `POST ${base}/v1/reports`,
      challenge: "lumi-report:<network>:<tx_hash>  (XRPL: tx hash uppercase; Base: 0x-prefixed lowercase)",
      xrpl_signature: "ripple-keypairs sign(<UTF-8 bytes of the challenge as hex>, privateKey), verified against the tx's SigningPubKey (single-signed payments only)",
      base_signature: "EIP-191 personal_sign of the challenge by the address that sent the USDC",
      fields: {
        vendor_id: "id from /v1/trust/vendors",
        network: "xrpl:0 | eip155:8453",
        tx_hash: "payment tx",
        reporter: "address that paid (XRPL r-address or 0x address)",
        signature: "hex signature of the challenge",
        outcome: REPORT_OUTCOMES.join(" | "),
        http_status: "optional, the status the vendor answered with",
        response_excerpt: "optional, up to 4000 chars; kept private",
      },
      limits: "20 per IP per day, 5 per minute; one verified report per tx",
    },
    tips: { endpoint: `POST ${base}/v1/tips`, privacy: "Stored privately. Never shown, published, or returned by any endpoint, MCP tool or A2A skill." },
    self: "Lumi does not list or score its own API.",
  };
}

function rightToReply(base: string) {
  return {
    email: CONTACT_EMAIL,
    endpoint: `POST ${base}/v1/trust/replies`,
    how:
      "Sign `lumi-reply:<vendor_id>:<sha256 hex of your reply text>` with the key of a pay-to address listed for your entry (XRPL: ripple-keypairs over the UTF-8 hex of the message, and include public_key; EVM: EIP-191 personal_sign) and POST {vendor_id, text, network, address, public_key?, signature}. Verified replies are shown with your entry. Or email us and we will add it.",
  };
}

const DISCLAIMER =
  "Automated observations by Lumi, reported as measured. They describe how an endpoint answered Lumi's requests at the times shown, not the intent or quality of the business behind it. Vendors can reply; see right_to_reply.";

function obsView(o: ObservationRow) {
  const evidence = `paid ${o.amount} ${o.asset} on ${iso(o.ts).replace(".000Z", "Z")}, tx ${o.tx_hash}, HTTP ${o.http_status ?? "none"}, response ${o.data_returned ? "contained data" : "contained no data"}`;
  return {
    observed_at: iso(o.ts),
    endpoint: o.endpoint,
    network: o.network,
    amount: o.amount,
    asset: o.asset,
    tx_hash: o.tx_hash,
    explorer: explorer(o.network, o.tx_hash),
    http_status: o.http_status,
    data_returned: o.data_returned,
    latency_ms: o.latency_ms,
    summary: o.summary,
    evidence,
    source: o.source === "lumi_buy" ? "Lumi paid buy (seeded)" : "Lumi daily test-buy",
  };
}

function probeView(p: ProbeRow) {
  return {
    checked_at: iso(p.ts),
    endpoint: p.endpoint,
    http_status: p.http_status,
    valid_quote: p.ok,
    price: p.price,
    asset: p.asset,
    pay_to: p.pay_to,
    source_tag_in_quote: p.source_tag,
    latency_ms: p.latency_ms,
    note: p.error,
  };
}

// ---------------------------------------------------------------- factory

export function createTrust(deps: TrustDeps): Trust {
  const { store, now } = deps;

  async function gather(v: Vendor) {
    const since = now() - WINDOW_DAYS * DAY;
    const [probes, obs, reports, replies] = await Promise.all([
      store.probeSummary(v.id, since),
      store.observations(v.id, since),
      store.verifiedReports(v.id, since),
      store.verifiedReplies(v.id),
    ]);
    return { probes, obs, reports, replies, score: scoreVendor(probes, obs, reports, now()) };
  }

  function header(base: string) {
    return {
      label: LABEL,
      methodology: `${base}/v1/trust/methodology`,
      window_days: WINDOW_DAYS,
      generated_at: iso(now()),
    };
  }

  async function vendorsDoc(base: string) {
    const rows = await Promise.all(
      VENDORS.map(async (v) => {
        const g = await gather(v);
        const last = g.obs[0];
        return {
          id: v.id,
          name: v.name,
          homepage: v.homepage,
          score: g.score.value,
          confidence: g.score.confidence,
          samples: g.score.samples,
          last_paid_observation: last ? obsView(last) : null,
          latest_probes: g.probes.latest.map(probeView),
          replies: g.replies.length,
          detail: `${base}/v1/trust/vendors/${v.id}`,
        };
      }),
    );
    return {
      kind: "trust_vendors",
      ...header(base),
      count: rows.length,
      ordering: "allowlist order (not ranked)",
      vendors: rows,
      right_to_reply: rightToReply(base),
      disclaimer: DISCLAIMER,
    };
  }

  async function vendorDoc(id: string, base: string) {
    const v = vendorById(id);
    if (!v) return null;
    const g = await gather(v);
    return {
      kind: "trust_vendor",
      ...header(base),
      id: v.id,
      name: v.name,
      homepage: v.homepage,
      pay_to: v.pay_to,
      endpoints: v.endpoints.map((e) => ({ url: e.url, method: e.method, listed_price: e.listed_price, listed_asset: e.listed_asset, daily_test_buy: !!e.test_buy })),
      score: { value: g.score.value, confidence: g.score.confidence, components: g.score.components, samples: g.score.samples },
      observations: g.obs.slice(0, 50).map(obsView),
      latest_probes: g.probes.latest.map(probeView),
      agent_reports: g.reports.slice(0, 50).map((r) => ({
        reported_at: iso(r.ts),
        network: r.network,
        tx_hash: r.tx_hash,
        explorer: explorer(r.network, r.tx_hash),
        amount: r.amount,
        asset: r.asset,
        http_status: r.http_status,
        outcome: r.outcome,
        counts_from: iso(r.ts + REPORT_HOLD_MS),
      })),
      vendor_replies: g.replies.map((r) => ({ replied_at: iso(r.ts), via: r.via, text: r.text })),
      right_to_reply: rightToReply(base),
      disclaimer: DISCLAIMER,
    };
  }

  // ---------------- probes (free, unpaid)

  async function probeEndpoint(v: Vendor, ep: VendorEndpoint): Promise<ProbeRow> {
    const t0 = Date.now();
    const row: ProbeRow = {
      vendor_id: v.id, endpoint: ep.url, ts: now(), http_status: null, ok: false, price: null, asset: null, pay_to: null, source_tag: null, latency_ms: null, error: null,
    };
    try {
      const r = await deps.fetch(ep.url, {
        method: ep.method,
        headers: {
          Accept: "application/json",
          "User-Agent": "LumiTrustProbe/0.6 (+https://api.lumitrades.io/v1/trust/methodology; unpaid quote check)",
          ...(ep.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: ep.method === "POST" ? JSON.stringify(ep.body ?? {}) : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const text = await r.text();
      row.latency_ms = Date.now() - t0;
      row.http_status = r.status;
      if (r.status !== 402) { row.error = `answered HTTP ${r.status} instead of a 402 quote`; return row; }
      let pr: any;
      const h = r.headers.get("PAYMENT-REQUIRED");
      try { pr = h ? decodeB64Json(h) : JSON.parse(text); } catch { /* below */ }
      if (!pr || !Array.isArray(pr.accepts)) { row.error = "402 without a readable x402 quote"; return row; }
      const xrpl = pr.accepts.filter((a: any) => a?.network === "xrpl:0");
      if (!xrpl.length) { row.error = "quote has no xrpl:0 option"; return row; }
      const pick = xrpl.find((a: any) => priceLabel(a).asset === ep.listed_asset) ?? xrpl[0];
      const { price, asset } = priceLabel(pick);
      row.price = price;
      row.asset = asset;
      row.pay_to = typeof pick.payTo === "string" ? pick.payTo.slice(0, 64) : null;
      row.source_tag = pick.extra?.sourceTag != null;
      if (!row.pay_to || !v.pay_to.xrpl.includes(row.pay_to)) { row.error = "quote pays an address not listed for this vendor"; return row; }
      row.ok = true;
      return row;
    } catch (e) {
      row.latency_ms = Date.now() - t0;
      row.error = /timeout|abort/i.test(String(e)) ? "no answer within 15 s" : "network error";
      return row;
    }
  }

  async function runProbes() {
    const rows = await Promise.all(VENDORS.flatMap((v) => v.endpoints.map((ep) => probeEndpoint(v, ep))));
    await store.addProbes(rows);
    await store.prune(now());
    const ok = rows.filter((r) => r.ok).length;
    deps.log({ event: "trust_probe", probes: rows.length, ok });
    return { probes: rows.length, ok };
  }

  // ---------------- rate limits (salted IP hashes only)

  async function ipHash(request: Request) {
    const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
    return hmacHex(deps.ipSecret, `ip:${ip}`);
  }

  async function limited(bucket: string, who: string, perMinute: number, perDay: number, globalPerDay: number): Promise<Response | null> {
    const t = now();
    const checks: [string, number, number][] = [
      [`${bucket}:m:${Math.floor(t / 60_000)}:${who}`, perMinute, (Math.floor(t / 60_000) + 1) * 60_000],
      [`${bucket}:d:${Math.floor(t / DAY)}:${who}`, perDay, (Math.floor(t / DAY) + 1) * DAY],
      [`${bucket}:d:${Math.floor(t / DAY)}:*`, globalPerDay, (Math.floor(t / DAY) + 1) * DAY],
    ];
    for (const [key, max, expires] of checks) {
      const n = await store.hit(key, expires);
      if (n > max) {
        return json(429, { error: "rate_limited", retry_after_seconds: Math.ceil((expires - t) / 1000) }, { "Retry-After": String(Math.ceil((expires - t) / 1000)) });
      }
    }
    return null;
  }

  async function isOwner(request: Request) {
    const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
    return isOwnerKey(m?.[1], deps.ownerKey);
  }

  // ---------------- POST /v1/reports

  async function postReport(request: Request): Promise<Response> {
    const who = await ipHash(request);
    const rl = await limited("report", who, 5, 20, 2000);
    if (rl) return rl;
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendor = typeof b.vendor_id === "string" ? vendorById(b.vendor_id) : undefined;
    if (!vendor) return json(404, { error: "unknown_vendor", vendors: VENDORS.map((v) => v.id) });
    const network = b.network ?? "xrpl:0";
    if (network !== "xrpl:0" && network !== "eip155:8453") return bad("network", "xrpl:0 or eip155:8453");
    const evm = network === "eip155:8453";
    const txRaw = typeof b.tx_hash === "string" ? b.tx_hash.trim() : "";
    const tx = evm ? txRaw.toLowerCase() : txRaw.toUpperCase();
    if (!(evm ? EVM_TX_RE : XRPL_TX_RE).test(tx)) return bad("tx_hash", evm ? "0x + 64 hex chars" : "64 hex chars");
    const reporterRaw = typeof b.reporter === "string" ? b.reporter.trim() : "";
    if (!(evm ? EVM_ADDR_RE : XRPL_ADDR_RE).test(reporterRaw)) return bad("reporter", evm ? "0x address" : "XRPL r-address");
    const reporter = evm ? reporterRaw.toLowerCase() : reporterRaw;
    const outcome = b.outcome;
    if (typeof outcome !== "string" || !(REPORT_OUTCOMES as readonly string[]).includes(outcome)) return bad("outcome", REPORT_OUTCOMES.join(" | "));
    const httpStatus = b.http_status == null ? null : Number(b.http_status);
    if (httpStatus != null && !(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) return bad("http_status", "integer 100-599");
    if (b.response_excerpt != null && (typeof b.response_excerpt !== "string" || b.response_excerpt.length > 4000)) return bad("response_excerpt", "string, max 4000 chars");
    const signature = typeof b.signature === "string" ? b.signature.trim() : "";
    if (signature && !/^(0x)?[0-9a-fA-F]{64,300}$/.test(signature)) return bad("signature", "hex");

    if (await store.hasVerifiedReport(tx)) return json(409, { error: "duplicate_report", detail: "A verified report for this transaction already exists." });

    const challenge = `lumi-report:${network}:${tx}`;
    let reason: string | null = null;
    let pay: LedgerPayment | undefined;
    const look = evm ? await lookupBaseUsdc(deps.fetch, deps.baseRpc, tx) : await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (!look.ok && look.reason === "ledger_unavailable") {
      return json(503, { error: "ledger_unavailable", detail: "Could not reach the ledger to verify this transaction; nothing was stored. Try again later.", retryable: true }, { "Retry-After": "60" });
    }
    if (!look.ok) reason = look.reason;
    else {
      const payTos = evm ? (vendor.pay_to.evm ?? []).map((a) => a.toLowerCase()) : vendor.pay_to.xrpl;
      const fromReporter = look.payments.filter((p) => p.from === reporter);
      pay = fromReporter.find((p) => payTos.includes(p.to));
      if (!fromReporter.length) reason = "sender_mismatch";
      else if (!pay) reason = "recipient_not_vendor";
      else if (!(pay.ts <= now() + 60_000 && pay.ts >= now() - REPORT_MAX_AGE_MS)) reason = "tx_too_old";
      else if (!signature) reason = "signature_required";
      else if (evm) {
        if (recoverEvmSigner(challenge, signature) !== reporter) reason = "bad_signature";
      } else if (!pay.signingPubKey) reason = "multisig_unsupported";
      else if (!verifyXrplSignature(challenge, signature, pay.signingPubKey)) reason = "bad_signature";
    }
    const verified = reason == null;
    const row: ReportRow = {
      id: crypto.randomUUID(),
      vendor_id: vendor.id,
      network: String(network),
      tx_hash: tx,
      reporter,
      tx_ts: pay?.ts ?? null,
      amount: pay?.amount ?? null,
      asset: pay?.asset ?? null,
      http_status: httpStatus,
      outcome,
      excerpt: typeof b.response_excerpt === "string" ? cleanText(b.response_excerpt).slice(0, 4000) : null,
      signed: !!signature,
      verified,
      reason,
      ip_hash: who,
      ts: now(),
    };
    const ins = await store.addReport(row);
    if (ins === "duplicate") return json(409, { error: "duplicate_report", detail: "A verified report for this transaction already exists." });
    deps.log({ event: "trust_report", vendor: vendor.id, verified, reason });
    if (!verified) {
      return json(422, {
        accepted: false,
        verified: false,
        reason,
        challenge,
        note: "Not verified: this report is stored privately for abuse review and is not shown or scored. See the methodology for what a verified report needs.",
        methodology: "/v1/trust/methodology",
      });
    }
    return json(201, {
      accepted: true,
      verified: true,
      id: row.id,
      vendor_id: vendor.id,
      counts_from: iso(row.ts + REPORT_HOLD_MS),
      note: "Verified (on-ledger payment + payer signature). Shown on the vendor entry now; counts toward the score after a 24 h hold.",
    });
  }

  // ---------------- POST /v1/tips (private)

  async function postTip(request: Request): Promise<Response> {
    const who = await ipHash(request);
    const rl = await limited("tip", who, 3, 10, 1000);
    if (rl) return rl;
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const text = typeof b.text === "string" ? cleanText(b.text) : "";
    if (text.length < 10 || text.length > 1000) return bad("text", "string, 10-1000 chars");
    let coins: string[] = [];
    if (b.coins != null) {
      if (!Array.isArray(b.coins) || b.coins.length > 10 || !b.coins.every((c) => typeof c === "string" && /^[A-Za-z0-9]{1,12}$/.test(c))) return bad("coins", "up to 10 symbols, 1-12 alphanumeric chars");
      coins = (b.coins as string[]).map((c) => c.toUpperCase());
    }
    let urls: string[] = [];
    if (b.source_urls != null) {
      const ok = Array.isArray(b.source_urls) && b.source_urls.length <= 5 && b.source_urls.every((u) => {
        if (typeof u !== "string" || u.length > 300) return false;
        try { return new URL(u).protocol === "https:"; } catch { return false; }
      });
      if (!ok) return bad("source_urls", "up to 5 https URLs, max 300 chars each");
      urls = b.source_urls as string[];
    }
    const id = crypto.randomUUID();
    await store.addTip({ id, text, coins: coins.length ? coins.join(",") : null, urls: urls.length ? JSON.stringify(urls) : null, ip_hash: who, ts: now() });
    deps.log({ event: "trust_tip" });
    return json(202, { received: true, id, privacy: "Stored privately. Tips are never shown, published, or returned by any endpoint." });
  }

  // ---------------- POST /v1/trust/replies

  async function postReply(request: Request): Promise<Response> {
    const owner = await isOwner(request);
    const who = await ipHash(request);
    if (!owner) {
      const rl = await limited("reply", who, 3, 10, 500);
      if (rl) return rl;
    }
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendor = typeof b.vendor_id === "string" ? vendorById(b.vendor_id) : undefined;
    if (!vendor) return json(404, { error: "unknown_vendor", vendors: VENDORS.map((v) => v.id) });
    const text = typeof b.text === "string" ? scrubText(cleanText(b.text)) : "";
    if (text.length < 1 || text.length > 1000) return bad("text", "string, 1-1000 chars");
    if (owner) {
      if (b.via !== "email") return bad("via", "owner replies must set via: \"email\"");
      await store.addReply({ id: crypto.randomUUID(), vendor_id: vendor.id, text, via: "email", verified: true, ts: now() });
      return json(201, { accepted: true, verified: true, via: "email" });
    }
    const network = b.network ?? "xrpl:0";
    const address = typeof b.address === "string" ? b.address.trim() : "";
    const signature = typeof b.signature === "string" ? b.signature.trim() : "";
    if (!/^(0x)?[0-9a-fA-F]{64,300}$/.test(signature)) return bad("signature", "hex signature of the challenge");
    const challenge = `lumi-reply:${vendor.id}:${await sha256Hex(text)}`;
    let ok = false;
    let reason = "bad_signature";
    if (network === "eip155:8453") {
      if (!EVM_ADDR_RE.test(address)) return bad("address", "0x address");
      const listed = (vendor.pay_to.evm ?? []).map((a) => a.toLowerCase());
      if (!listed.includes(address.toLowerCase())) reason = "address_not_listed_for_vendor";
      else ok = recoverEvmSigner(challenge, signature) === address.toLowerCase();
    } else if (network === "xrpl:0") {
      if (!XRPL_ADDR_RE.test(address)) return bad("address", "XRPL r-address");
      const pub = typeof b.public_key === "string" ? b.public_key.trim() : "";
      if (!/^[0-9A-Fa-f]{66}$/.test(pub)) return bad("public_key", "33-byte hex public key");
      if (!vendor.pay_to.xrpl.includes(address)) reason = "address_not_listed_for_vendor";
      else if (verifyXrplSignature(challenge, signature, pub)) {
        const derived = xrplAddressOf(pub);
        if (derived === address) ok = true;
        else {
          const regular = await xrplRegularKey(deps.fetch, deps.xrplRpc, address);
          if (regular === undefined) return json(503, { error: "ledger_unavailable", retryable: true }, { "Retry-After": "60" });
          ok = !!regular && regular === derived;
          if (!ok) reason = "key_not_authorized_for_address";
        }
      }
    } else return bad("network", "xrpl:0 or eip155:8453");
    if (!ok) return json(422, { accepted: false, verified: false, reason, challenge, note: "Not stored. Sign the challenge with a key of a pay-to address listed for this vendor, or email " + CONTACT_EMAIL });
    await store.addReply({ id: crypto.randomUUID(), vendor_id: vendor.id, text, via: `signed:${address}`, verified: true, ts: now() });
    deps.log({ event: "trust_reply", vendor: vendor.id });
    return json(201, { accepted: true, verified: true, note: "Shown with the vendor entry." });
  }

  // ---------------- POST /v1/trust/observations (owner)

  async function postObservation(request: Request): Promise<Response> {
    if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendor = typeof b.vendor_id === "string" ? vendorById(b.vendor_id) : undefined;
    if (!vendor) return json(404, { error: "unknown_vendor", vendors: VENDORS.map((v) => v.id) });
    const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
    if (!vendor.endpoints.some((e) => e.url === endpoint)) return bad("endpoint", "one of the vendor's listed endpoint URLs");
    if ((b.network ?? "xrpl:0") !== "xrpl:0") return bad("network", "xrpl:0");
    const tx = typeof b.tx_hash === "string" ? b.tx_hash.trim().toUpperCase() : "";
    if (!XRPL_TX_RE.test(tx)) return bad("tx_hash", "64 hex chars");
    const httpStatus = b.http_status == null ? null : Number(b.http_status);
    if (httpStatus != null && !(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) return bad("http_status", "integer 100-599 or null");
    if (typeof b.data_returned !== "boolean") return bad("data_returned", "boolean");
    const latency = b.latency_ms == null ? null : Number(b.latency_ms);
    if (latency != null && !(Number.isInteger(latency) && latency >= 0 && latency <= 600_000)) return bad("latency_ms", "integer ms 0-600000 or null");
    const summary = typeof b.summary === "string" ? cleanText(b.summary) : "";
    if (summary.length < 1 || summary.length > 300) return bad("summary", "string, 1-300 chars");
    if (BANNED_WORDS.test(summary)) return bad("summary", "factual wording only (describe what was observed)");

    const look = await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (!look.ok) {
      if (look.reason === "ledger_unavailable") return json(503, { error: "ledger_unavailable", retryable: true }, { "Retry-After": "30" });
      return json(422, { recorded: false, reason: look.reason });
    }
    const pay = look.payments[0];
    if (!deps.buyers.includes(pay.from)) return json(422, { recorded: false, reason: "sender_not_lumi_wallet" });
    if (!vendor.pay_to.xrpl.includes(pay.to)) return json(422, { recorded: false, reason: "recipient_not_vendor" });
    if (b.amount != null && Math.abs(Number(b.amount) - Number(pay.amount)) > 1e-9) return json(422, { recorded: false, reason: "amount_mismatch", ledger_amount: pay.amount });
    if (b.asset != null && b.asset !== pay.asset) return json(422, { recorded: false, reason: "asset_mismatch", ledger_asset: pay.asset });

    const row: ObservationRow = {
      vendor_id: vendor.id,
      endpoint,
      ts: Number.isFinite(pay.ts) ? pay.ts : now(),
      network: "xrpl:0",
      tx_hash: tx,
      amount: pay.amount,
      asset: pay.asset,
      http_status: httpStatus,
      data_returned: b.data_returned,
      latency_ms: latency,
      summary,
      source: "lumi_test_buy",
    };
    const ins = await store.addObservation(row);
    deps.log({ event: "trust_observation", vendor: vendor.id, inserted: ins === "inserted" });
    if (ins === "duplicate") return json(200, { recorded: false, duplicate: true, tx_hash: tx });
    return json(201, { recorded: true, observation: obsView(row) });
  }

  async function handle(request: Request, path: string, base: string): Promise<Response | null> {
    const method = request.method;
    if (method === "GET" || method === "HEAD") {
      if (path === "/v1/trust/methodology") return json(200, methodologyDoc(base), { "Cache-Control": "public, max-age=3600" });
      if (path === "/v1/trust/vendors") return json(200, await vendorsDoc(base), { "Cache-Control": "public, max-age=120" });
      const m = path.match(/^\/v1\/trust\/vendors\/([a-z0-9-]{1,64})$/);
      if (m) {
        const doc = await vendorDoc(m[1], base);
        return doc ? json(200, doc, { "Cache-Control": "public, max-age=120" }) : json(404, { error: "unknown_vendor", vendors: VENDORS.map((v) => v.id) });
      }
      if (TRUST_POST_PATHS.includes(path)) return json(405, { error: "method_not_allowed", detail: "POST only." }, { Allow: "POST, OPTIONS" });
      return null;
    }
    if (method !== "POST") return TRUST_POST_PATHS.includes(path) || path.startsWith("/v1/trust/") ? json(405, { error: "method_not_allowed" }, { Allow: "GET, POST, OPTIONS" }) : null;
    switch (path) {
      case "/v1/reports":
        return postReport(request);
      case "/v1/tips":
        return postTip(request);
      case "/v1/trust/replies":
        return postReply(request);
      case "/v1/trust/observations":
        return postObservation(request);
      case "/v1/trust/probe":
        if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
        return json(200, { ran: true, ...(await runProbes()) });
    }
    return null;
  }

  return { handle, runProbes, vendorsDoc, vendorDoc };
}
