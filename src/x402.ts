/**
 * x402 v2 resource-server ("merchant") side for the XRPL `exact` scheme,
 * written for the Workers runtime (fetch + Web Crypto only, no Node APIs).
 *
 * Wire format mirrors the reference XRPL implementation (T54 `x402-xrpl`,
 * PyPI/npm 0.3.x) so its buyer SDKs work unchanged:
 *   402 body + `PAYMENT-REQUIRED` header (base64 JSON PaymentRequired)
 *   client retries with `PAYMENT-SIGNATURE` (base64 JSON PaymentPayload holding a
 *   presigned XRPL Payment blob bound to our invoiceId)
 *   we call facilitator POST /verify then POST /settle, then serve the data with a
 *   `PAYMENT-RESPONSE` header (base64 JSON SettlementResponse incl. the tx hash).
 *
 * Difference from the reference FastAPI/Express middleware: invoices are
 * stateless HMAC tokens instead of an in-memory store, because Worker isolates
 * do not share memory. One-time redemption is enforced by a ReplayGuard
 * (Durable Object in production; memory for a single Node process).
 */

import type { Config, DurableObjectNamespaceLike, KVLike } from "./config";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** Legacy/alias header name used in some x402 docs. */
export const HEADER_X_PAYMENT = "X-PAYMENT";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface Settlement {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export interface Quote {
  /** Route + parameters this quote is for, e.g. "signal:XRP". Bound into the invoice. */
  routeKey: string;
  amountDrops: string;
  description: string;
  resourceUrl: string;
}

// ---------------------------------------------------------------- encoding

export function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeUtf8(s: string): string {
  const bin = atob(s.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Deterministic JSON (sorted keys, no spaces), matching the reference SDK's header encoding. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function encodeHeader(obj: unknown): string {
  return b64encodeUtf8(canonicalJson(obj));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------- invoices

const INVOICE_PREFIX = "lumi1";

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return b64url(sig.slice(0, 16));
}

function macInput(cfg: Config, routeKey: string, amount: string, exp: string, nonce: string): string {
  return [INVOICE_PREFIX, routeKey, amount, cfg.network, cfg.payTo, exp, nonce].join("|");
}

/** invoiceId = lumi1.<routeKey>.<expiry base36>.<nonce>.<mac> */
export async function issueInvoiceId(cfg: Config, quote: Quote, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000 + cfg.invoiceTtlSeconds).toString(36);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const mac = await hmac(cfg.invoiceSecret, macInput(cfg, quote.routeKey, quote.amountDrops, exp, nonce));
  return [INVOICE_PREFIX, quote.routeKey, exp, nonce, mac].join(".");
}

export type InvoiceCheck =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "malformed_invoice" | "invalid_invoice" | "invoice_expired" | "invoice_route_mismatch" };

export async function checkInvoiceId(
  cfg: Config,
  invoiceId: string,
  quote: Quote,
  nowMs = Date.now(),
): Promise<InvoiceCheck> {
  const parts = invoiceId.split(".");
  if (parts.length !== 5 || parts[0] !== INVOICE_PREFIX) return { ok: false, reason: "malformed_invoice" };
  const [, routeKey, exp, nonce, mac] = parts;
  const expected = await hmac(cfg.invoiceSecret, macInput(cfg, routeKey, quote.amountDrops, exp, nonce));
  if (!timingSafeEqual(mac, expected)) return { ok: false, reason: "invalid_invoice" };
  if (routeKey !== quote.routeKey) return { ok: false, reason: "invoice_route_mismatch" };
  const expiresAt = parseInt(exp, 36) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs) return { ok: false, reason: "invoice_expired" };
  return { ok: true, expiresAt };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- replay guard

/**
 * Each invoice may be redeemed once. This MUST be enforced here: the facilitator
 * treats re-settling an already-validated blob as success (XRPL submission is
 * idempotent on the tx hash), so it will not stop a replayed PAYMENT-SIGNATURE.
 */
export interface ReplayGuard {
  /** Cheap pre-check (may have false negatives). */
  isUsed(invoiceId: string): Promise<boolean>;
  /** Atomically claim the invoice. Returns false if it was already claimed. */
  claim(invoiceId: string, ttlSeconds: number): Promise<boolean>;
}

/** Per-isolate memory guard. Correct for a single Node process; NOT across Worker isolates. */
export class MemoryReplayGuard implements ReplayGuard {
  private mem = new Map<string, number>();

  async isUsed(id: string): Promise<boolean> {
    const until = this.mem.get(id);
    return until !== undefined && until > Date.now();
  }

  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    for (const [k, until] of this.mem) if (until <= now) this.mem.delete(k);
    if (await this.isUsed(id)) return false;
    this.mem.set(id, now + ttlSeconds * 1000);
    return true;
  }
}

/** Memory + Workers KV. KV is eventually consistent, so a fast cross-region replay can slip through. */
export class KvReplayGuard extends MemoryReplayGuard {
  constructor(private kv: KVLike) {
    super();
  }
  async isUsed(id: string): Promise<boolean> {
    return (await super.isUsed(id)) || (await this.kv.get(`inv:${id}`)) !== null;
  }
  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    if (await this.isUsed(id)) return false;
    await super.claim(id, ttlSeconds);
    await this.kv.put(`inv:${id}`, "1", { expirationTtl: Math.max(60, ttlSeconds) });
    return true;
  }
}

/** Strongly consistent guard backed by the InvoiceGuard Durable Object (16 shards). */
export class DurableObjectReplayGuard extends MemoryReplayGuard {
  constructor(private ns: DurableObjectNamespaceLike) {
    super();
  }
  private stub(id: string) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return this.ns.get(this.ns.idFromName(`shard-${h % 16}`));
  }
  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    if (await super.isUsed(id)) return false;
    const res = await this.stub(id).fetch("https://invoice-guard/claim", {
      method: "POST",
      body: JSON.stringify({ id, ttlSeconds }),
    });
    if (res.status !== 200 && res.status !== 409) throw new Error(`invoice guard HTTP ${res.status}`);
    const ok = res.status === 200;
    if (ok) await super.claim(id, ttlSeconds);
    return ok;
  }
}

export function makeReplayGuard(opts: { durableObject?: DurableObjectNamespaceLike; kv?: KVLike }): ReplayGuard {
  if (opts.durableObject) return new DurableObjectReplayGuard(opts.durableObject);
  if (opts.kv) return new KvReplayGuard(opts.kv);
  return new MemoryReplayGuard();
}

// ---------------------------------------------------------------- requirements

export function buildRequirements(cfg: Config, quote: Quote, invoiceId: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: quote.amountDrops,
    asset: "XRP",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.invoiceTtlSeconds,
    extra: { invoiceId, sourceTag: cfg.sourceTag },
  };
}

export async function buildPaymentRequired(cfg: Config, quote: Quote, error: string): Promise<PaymentRequired> {
  const invoiceId = await issueInvoiceId(cfg, quote);
  return {
    x402Version: 2,
    error,
    resource: { url: quote.resourceUrl, description: quote.description, mimeType: "application/json" },
    accepts: [buildRequirements(cfg, quote, invoiceId)],
    extensions: {},
  };
}

// ---------------------------------------------------------------- responses

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": `${HEADER_PAYMENT_REQUIRED}, ${HEADER_PAYMENT_RESPONSE}, X-Correlation-ID, Retry-After`,
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers },
  });
}

async function paymentRequiredResponse(cfg: Config, quote: Quote, error: string): Promise<Response> {
  const body = await buildPaymentRequired(cfg, quote, error);
  return json(402, body, { [HEADER_PAYMENT_REQUIRED]: encodeHeader(body), "Cache-Control": "no-store" });
}

function decodePaymentPayload(header: string): PaymentPayload | null {
  try {
    const obj = JSON.parse(b64decodeUtf8(header));
    if (!obj || typeof obj !== "object" || typeof obj.accepted !== "object" || obj.accepted === null) return null;
    return obj as PaymentPayload;
  } catch {
    return null;
  }
}

function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    String(a.amount) === String(b.amount) &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    Number(a.maxTimeoutSeconds) === Number(b.maxTimeoutSeconds) &&
    a.extra?.invoiceId === b.extra?.invoiceId
  );
}

export interface PaywallDeps {
  fetch: typeof fetch;
  replay: ReplayGuard;
  log?: (event: Record<string, unknown>) => void;
}

const LEGACY_UNKNOWN = /^(submit_failed:|submit_missing_tx_hash|validation_failed:)/;

/**
 * Gate `serve` behind an x402 payment. `serve` only runs after the facilitator
 * reports a successful on-ledger settlement for exactly this quote.
 */
export async function requirePayment(
  request: Request,
  cfg: Config,
  deps: PaywallDeps,
  quote: Quote,
  serve: (settlement: Settlement) => Promise<Response> | Response,
): Promise<Response> {
  const header = request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT);
  if (!header) return paymentRequiredResponse(cfg, quote, "PAYMENT-SIGNATURE header is required");

  const payload = decodePaymentPayload(header);
  if (!payload) return json(400, { error: "invalid_payment_signature_header" });
  if (payload.x402Version !== 2) return json(400, { error: "invalid_x402_version" });

  const invoiceId =
    (typeof payload.payload?.invoiceId === "string" && payload.payload.invoiceId) ||
    (typeof payload.accepted.extra?.invoiceId === "string" && (payload.accepted.extra.invoiceId as string)) ||
    "";
  if (!invoiceId) return json(400, { error: "missing_invoiceId" });

  const check = await checkInvoiceId(cfg, invoiceId, quote);
  if (!check.ok) return paymentRequiredResponse(cfg, quote, check.reason);

  const expected = buildRequirements(cfg, quote, invoiceId);
  if (!sameRequirements(expected, payload.accepted)) {
    return paymentRequiredResponse(cfg, quote, "payment_requirements_mismatch");
  }
  if (await deps.replay.isUsed(invoiceId)) {
    return paymentRequiredResponse(cfg, quote, "invoice_already_used");
  }

  const facilitatorBody = JSON.stringify({ paymentPayload: payload, paymentRequirements: expected });
  const post = (path: string) =>
    deps.fetch(`${cfg.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: facilitatorBody,
    });

  // ---- verify (no money moves; safe to retry)
  let verifyResp: Response;
  try {
    verifyResp = await post("/verify");
  } catch {
    return transient("facilitator_unavailable");
  }
  if (verifyResp.status === 408 || verifyResp.status === 429 || verifyResp.status >= 500) {
    return transient("facilitator_unavailable", verifyResp.headers.get("Retry-After"));
  }
  const verifyJson = (await verifyResp.json().catch(() => null)) as Record<string, unknown> | null;
  if (verifyResp.status !== 200 || !verifyJson || typeof verifyJson.isValid !== "boolean") {
    return json(502, { error: "invalid_verify_response", retryable: false, phase: "verify", settlementAttempted: false });
  }
  if (!verifyJson.isValid) {
    const reason = String(verifyJson.invalidReason || "verify_failed");
    if (reason === "verifiable_intent_denied") {
      return json(403, { error: reason, retryable: false, phase: "verify", settlementAttempted: false });
    }
    return paymentRequiredResponse(cfg, quote, `verify_failed:${reason}`);
  }

  // Atomically claim the invoice before settling, so a replayed or concurrent
  // duplicate PAYMENT-SIGNATURE can never be served twice.
  const ttl = Math.max(60, Math.ceil((check.expiresAt - Date.now()) / 1000) + 60);
  let claimed: boolean;
  try {
    claimed = await deps.replay.claim(invoiceId, ttl);
  } catch {
    return transient("invoice_guard_unavailable");
  }
  if (!claimed) return paymentRequiredResponse(cfg, quote, "invoice_already_used");

  // ---- settle (submits the presigned Payment to the XRP Ledger)
  let settleResp: Response;
  try {
    settleResp = await post("/settle");
  } catch {
    return settlementUnknown();
  }
  const settleJson = (await settleResp.json().catch(() => null)) as Record<string, unknown> | null;
  if (settleResp.status !== 200) {
    if (settleJson?.settlementAttempted === true) return settlementUnknown();
    return json(502, {
      error: `settle_http_error:${settleResp.status}`,
      reason: "settlement_status_unknown",
      retryable: false,
      phase: "settle",
      settlementAttempted: true,
    });
  }
  if (!settleJson || typeof settleJson.success !== "boolean") return settlementUnknown();
  if (!settleJson.success) {
    if (LEGACY_UNKNOWN.test(String(settleJson.errorReason || ""))) return settlementUnknown();
    return paymentRequiredResponse(cfg, quote, `settle_failed:${settleJson.errorReason ?? "unknown"}`);
  }

  const settlement: Settlement = {
    success: true,
    transaction: String(settleJson.transaction || ""),
    network: String(settleJson.network || cfg.network),
    payer: typeof settleJson.payer === "string" ? settleJson.payer : undefined,
  };
  deps.log?.({
    event: "x402_settled",
    route: quote.routeKey,
    amountDrops: quote.amountDrops,
    network: settlement.network,
    tx: settlement.transaction,
    payer: settlement.payer,
  });

  const resp = await serve(settlement);
  const out = new Response(resp.body, resp);
  out.headers.set(HEADER_PAYMENT_RESPONSE, settleResp.headers.get(HEADER_PAYMENT_RESPONSE) || encodeHeader(settlement));
  out.headers.set("Cache-Control", "no-store");
  return out;
}

function transient(reason: string, retryAfter?: string | null): Response {
  const ra = Math.max(0, Number(retryAfter) || 5);
  const correlationId = crypto.randomUUID();
  return json(
    503,
    { error: reason, reason, retryable: true, retryAfter: ra, correlationId, phase: "verify", settlementAttempted: false },
    { "Retry-After": String(ra), "X-Correlation-ID": correlationId },
  );
}

function settlementUnknown(): Response {
  const correlationId = crypto.randomUUID();
  return json(
    409,
    {
      error: "settlement_status_unknown",
      reason: "settlement_status_unknown",
      retryable: false,
      correlationId,
      phase: "settle",
      settlementAttempted: true,
    },
    { "X-Correlation-ID": correlationId },
  );
}
