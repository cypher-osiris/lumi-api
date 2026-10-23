/**
 * Signed test-buy receipts: `counterparty_delivery_receipt` v0.1 (proposed ARS evidence type,
 * notes/outreach/xrpl_drafts.md §2.1).
 *
 * One receipt per Lumi test-buy of a seller. The body is hashed as SHA-256 of its RFC 8785-style canonical JSON
 * (with `receipt_hash` and `signer` removed) and the PAYING wallet signs `lumi-receipt:<network>:<tx_hash>:<receipt_hash>`
 * (XRPL: ripple-keypairs over the UTF-8 hex of the message; Base: EIP-191 personal_sign).
 * Signing happens only on the operator box (tools/sign_receipts.ts); the Worker never holds a wallet key. It only verifies
 * and stores receipts, serves them in paid trust/check and the paid vendor report, and verifies any receipt for free.
 */
import { recoverEvmSigner, sha256Hex, verifyXrplSignature, xrplAddressOf, XRPL_ADDR_RE, EVM_ADDR_RE, XRPL_TX_RE, EVM_TX_RE } from "./verify";
import type { D1Like } from "../config";

export const RECEIPT_TYPE = "counterparty_delivery_receipt";
export const RECEIPT_VERSION = "ars-evidence/0.1";
export const RECEIPT_OUTCOMES = ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other"] as const;
export type ReceiptNetwork = "xrpl:0" | "eip155:8453";

export interface Receipt {
  type: typeof RECEIPT_TYPE;
  version: typeof RECEIPT_VERSION;
  receipt_id: string;
  issued_at: string;
  issuer: { name: string; methodology_url: string; methodology_version: string };
  seller: { vendor_id?: string; endpoint: string; domain?: string; pay_to: string };
  payment: {
    network: ReceiptNetwork; asset: string; issuer?: string; amount: string; amount_atomic?: number;
    tx_hash: string; payer: string; ledger_result: string; ledger_index?: number; block_number?: number;
  };
  delivery: { observed_at: string; http_status: number; data_returned: boolean; outcome: (typeof RECEIPT_OUTCOMES)[number]; latency_ms?: number; source?: string };
  receipt_hash: string;
  signer: { key_type: "ripple-keypairs" | "eip191"; address: string; public_key?: string; message: string; signature: string };
}
export type ReceiptBody = Omit<Receipt, "receipt_hash" | "signer">;

/** RFC 8785-style canonical JSON: object keys sorted by UTF-16 code units, no whitespace, undefined members dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** SHA-256 hex of the canonical body (receipt_hash and signer removed). */
export async function receiptHash(r: ReceiptBody | Receipt): Promise<string> {
  const { receipt_hash: _h, signer: _s, ...body } = r as Receipt;
  return sha256Hex(canonicalJson(body));
}

export const receiptMessage = (network: string, tx: string, hash: string) => `lumi-receipt:${network}:${tx}:${hash}`;

/** delivery.outcome from a stored test-buy row. */
export function outcomeOf(httpStatus: number | null | undefined, dataReturned: boolean, summary = ""): Receipt["delivery"]["outcome"] {
  if (dataReturned) return "delivered";
  if (httpStatus == null || httpStatus === 0) return /timeout|timed out|abort/i.test(summary) ? "timeout" : "other";
  if (httpStatus >= 200 && httpStatus < 300) return /empty/i.test(summary) ? "empty_result" : "no_data";
  return "error_status";
}

export interface ReceiptCheck {
  ok: boolean;
  hash_ok: boolean;
  signature_ok: boolean;
  signer_is_payer: boolean;
  errors: string[];
  recomputed_hash?: string;
}

/** Offline checks: shape, hash, signature, signer = payer. No network. */
export async function verifyReceipt(r: any): Promise<ReceiptCheck> {
  const errors: string[] = [];
  const out: ReceiptCheck = { ok: false, hash_ok: false, signature_ok: false, signer_is_payer: false, errors };
  if (!r || typeof r !== "object") { errors.push("not_an_object"); return out; }
  if (r.type !== RECEIPT_TYPE) errors.push("type");
  if (r.version !== RECEIPT_VERSION) errors.push("version");
  for (const k of ["receipt_id", "issued_at", "issuer", "seller", "payment", "delivery", "receipt_hash", "signer"]) if (r[k] == null) errors.push("missing_" + k);
  if (errors.length) return out;
  const p = r.payment, s = r.signer;
  if (p.network !== "xrpl:0" && p.network !== "eip155:8453") errors.push("payment.network");
  if (p.network === "xrpl:0" && !XRPL_TX_RE.test(String(p.tx_hash))) errors.push("payment.tx_hash");
  if (p.network === "eip155:8453" && !EVM_TX_RE.test(String(p.tx_hash))) errors.push("payment.tx_hash");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(String(p.amount))) errors.push("payment.amount");
  if (!RECEIPT_OUTCOMES.includes(r.delivery?.outcome)) errors.push("delivery.outcome");
  if (!/^[0-9a-f]{64}$/.test(String(r.receipt_hash))) errors.push("receipt_hash");
  let hash = "";
  try { hash = await receiptHash(r); } catch { errors.push("canonicalization"); }
  out.recomputed_hash = hash || undefined;
  out.hash_ok = !!hash && hash === r.receipt_hash;
  if (!out.hash_ok) errors.push("hash_mismatch");
  const msg = receiptMessage(p.network, String(p.tx_hash), String(r.receipt_hash));
  if (s.message !== msg) errors.push("signer.message");
  if (s.key_type === "ripple-keypairs") {
    if (p.network !== "xrpl:0") errors.push("key_type_network");
    const pk = String(s.public_key ?? "");
    out.signature_ok = !!pk && verifyXrplSignature(msg, String(s.signature), pk) && xrplAddressOf(pk) === s.address;
    if (!XRPL_ADDR_RE.test(String(s.address))) errors.push("signer.address");
    out.signer_is_payer = s.address === p.payer;
  } else if (s.key_type === "eip191") {
    if (p.network !== "eip155:8453") errors.push("key_type_network");
    const rec = recoverEvmSigner(msg, String(s.signature));
    out.signature_ok = !!rec && EVM_ADDR_RE.test(String(s.address)) && rec === String(s.address).toLowerCase();
    out.signer_is_payer = String(s.address).toLowerCase() === String(p.payer).toLowerCase();
  } else errors.push("signer.key_type");
  if (!out.signature_ok) errors.push("signature_invalid");
  if (!out.signer_is_payer) errors.push("signer_not_payer");
  out.ok = !errors.length;
  return out;
}

// ---------------------------------------------------------------- store

export interface ReceiptStore {
  put(rows: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[]): Promise<number>;
  byTx(txs: string[]): Promise<Map<string, Receipt>>;
  /** Stored test-buys with no receipt yet (owner backfill / forward signing). */
  pending(limit: number): Promise<PendingBuy[]>;
  /** The stored test-buy for a tx (either table), signed or not. */
  buy(tx: string): Promise<PendingBuy | null>;
  count(): Promise<number>;
}

export interface PendingBuy {
  kind: "vendor" | "catalog";
  ref: string; // vendor_id or catalog resource key
  endpoint: string;
  domain: string | null;
  pay_to: string | null; // known for catalog buys; vendor buys: read from the ledger by the signer
  ts: number;
  network: string;
  tx_hash: string;
  amount: string;
  asset: string;
  http_status: number | null;
  data_returned: boolean;
  latency_ms: number | null;
  summary: string;
  source: string;
}

export class MemoryReceiptStore implements ReceiptStore {
  rows = new Map<string, { network: string; kind: string; ref: string; receipt: Receipt }>();
  buys: PendingBuy[] = [];
  async put(rows: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[]) {
    for (const r of rows) this.rows.set(r.tx_hash, r);
    return rows.length;
  }
  async byTx(txs: string[]) {
    const m = new Map<string, Receipt>();
    for (const t of txs) { const r = this.rows.get(t); if (r) m.set(t, r.receipt); }
    return m;
  }
  async pending(limit: number) { return this.buys.filter((b) => !this.rows.has(b.tx_hash)).slice(0, limit); }
  async buy(tx: string) { return this.buys.find((b) => b.tx_hash === tx) ?? null; }
  async count() { return this.rows.size; }
}

export class D1ReceiptStore implements ReceiptStore {
  constructor(private db: D1Like) {}
  async put(rows: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[]) {
    if (!rows.length) return 0;
    await this.db.batch(rows.map((r) =>
      this.db.prepare("INSERT OR REPLACE INTO receipts (tx_hash, network, kind, ref, receipt_hash, receipt, stored_at) VALUES (?,?,?,?,?,?,?)")
        .bind(r.tx_hash, r.network, r.kind, r.ref, r.receipt.receipt_hash, JSON.stringify(r.receipt), Date.now())));
    return rows.length;
  }
  async byTx(txs: string[]) {
    const m = new Map<string, Receipt>();
    const all = [...new Set(txs)].slice(0, 450);
    for (let i = 0; i < all.length; i += 90) {
      const u = all.slice(i, i + 90);
      const res = await this.db.prepare(`SELECT tx_hash, receipt FROM receipts WHERE tx_hash IN (${u.map(() => "?").join(",")})`).bind(...u).all<{ tx_hash: string; receipt: string }>();
      for (const r of res.results ?? []) { try { m.set(r.tx_hash, JSON.parse(r.receipt)); } catch { /* skip */ } }
    }
    return m;
  }
  async pending(limit: number) {
    const n = Math.max(1, Math.min(200, limit));
    const res = await this.db.prepare(
      `SELECT 'vendor' kind, vendor_id ref, endpoint, NULL domain, NULL pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source
         FROM observations o WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.tx_hash = o.tx_hash)
       UNION ALL
       SELECT 'catalog', resource, resource, domain, pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, 'lumi_catalog_buy'
         FROM catalog_buys b WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.tx_hash = b.tx_hash)
       ORDER BY ts LIMIT ?`).bind(n).all<any>();
    return (res.results ?? []).map((r: any) => ({ ...r, data_returned: !!r.data_returned }));
  }
  async buy(tx: string) {
    const r = await this.db.prepare(
      `SELECT 'vendor' kind, vendor_id ref, endpoint, NULL domain, NULL pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source FROM observations WHERE tx_hash = ?1
       UNION ALL
       SELECT 'catalog', resource, resource, domain, pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, 'lumi_catalog_buy' FROM catalog_buys WHERE tx_hash = ?1 LIMIT 1`).bind(tx).first<any>();
    return r ? { ...r, data_returned: !!r.data_returned } : null;
  }
  async count() {
    return (await this.db.prepare("SELECT COUNT(*) n FROM receipts").first<{ n: number }>())?.n ?? 0;
  }
}

/** The stored buy a receipt must describe (owner upload check). */
export function receiptMatchesBuy(r: Receipt, b: PendingBuy): string | null {
  if (r.payment.network !== b.network) return "network_mismatch";
  if (r.payment.tx_hash !== b.tx_hash) return "tx_mismatch";
  if (Math.abs(Number(r.payment.amount) - Number(b.amount)) > 1e-9) return "amount_mismatch";
  if (r.payment.asset !== b.asset) return "asset_mismatch";
  if (b.pay_to && r.seller.pay_to.toLowerCase() !== b.pay_to.toLowerCase()) return "pay_to_mismatch";
  if (r.delivery.data_returned !== b.data_returned) return "delivery_mismatch";
  if (r.delivery.http_status !== (b.http_status ?? 0)) return "http_status_mismatch";
  return null;
}

/** Free doc: how to verify a receipt yourself. */
export function receiptVerifyDoc(base: string) {
  return {
    kind: "receipt_verification",
    type: RECEIPT_TYPE,
    version: RECEIPT_VERSION,
    status: "PROPOSED evidence format (v0.1); Lumi issues one per test-buy of a seller.",
    where_receipts_are: `Paid only: ${base}/v1/trust/check?url=<resource> ($0.004; purchases[].receipt) and ${base}/v1/trust/vendors/{id}/report ($0.02; paid_test_buys.history[].receipt). Free lookups stay answer-only.`,
    verify_online: `POST ${base}/v1/trust/receipts/verify with the receipt JSON as the body (free). Returns hash/signature checks and, with ?ledger=1, an on-chain check of the payment.`,
    verify_yourself: [
      "1. receipt_hash: remove receipt_hash and signer, serialise the rest as RFC 8785-style canonical JSON (keys sorted, no whitespace), SHA-256, lowercase hex. It must equal receipt_hash.",
      "2. message: signer.message must equal `lumi-receipt:<payment.network>:<payment.tx_hash>:<receipt_hash>`.",
      "3. signature: XRPL (key_type ripple-keypairs): ripple-keypairs verify(<UTF-8 bytes of message as uppercase hex>, signature, public_key), and deriveAddress(public_key) = signer.address. Base (key_type eip191): EIP-191 personal_sign recovery of message gives signer.address.",
      "4. signer.address must equal payment.payer.",
      "5. ledger: fetch payment.tx_hash. XRPL: validated, tesSUCCESS, Account = payer, Destination = seller.pay_to, delivered_amount = amount/asset, and SigningPubKey = signer.public_key. Base: status success with a USDC (0x8335…2913) Transfer from payer to seller.pay_to for amount.",
      "6. delivery.* is the tester's signed statement about what the paid call returned. It cannot be proven on-chain; the seller can answer via the right to reply.",
    ],
    example_code_js: [
      "import { verify, deriveAddress } from 'ripple-keypairs'; import { recoverMessageAddress, sha256, toHex } from 'viem';",
      "const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';",
      "const { receipt_hash, signer, ...body } = receipt; const h = sha256(toHex(canon(body))).slice(2); // must equal receipt_hash",
      "// XRPL: verify(Buffer.from(signer.message, 'utf8').toString('hex').toUpperCase(), signer.signature, signer.public_key) && deriveAddress(signer.public_key) === signer.address",
      "// Base: (await recoverMessageAddress({ message: signer.message, signature: signer.signature })).toLowerCase() === signer.address.toLowerCase()",
    ],
    keys: "Signed on Lumi's operator box with the wallet that paid. Lumi's API never holds or exposes wallet keys.",
    methodology: `${base}/v1/trust/methodology`,
  };
}

/** Build the unsigned receipt body for a stored test-buy plus what the ledger says about the payment. */
export function buildReceiptBody(
  b: PendingBuy,
  chain: { payer: string; pay_to: string; ledger_result: string; ledger_index?: number; block_number?: number; iou_issuer?: string },
  opts: { base?: string; issuedAt: string },
): ReceiptBody {
  const base = opts.base ?? "https://api.lumitrades.io";
  const xrpl = b.network === "xrpl:0";
  let domain = b.domain ?? undefined;
  let endpoint = b.endpoint;
  if (!/^https?:\/\//i.test(endpoint)) endpoint = "https://" + endpoint;
  try { domain = domain ?? new URL(endpoint).hostname.toLowerCase(); } catch { /* keep */ }
  const atomic = b.asset === "XRP" ? Math.round(Number(b.amount) * 1e6) : b.asset === "USDC" ? Math.round(Number(b.amount) * 1e6) : undefined;
  return {
    type: RECEIPT_TYPE,
    version: RECEIPT_VERSION,
    receipt_id: `lumi-${xrpl ? "xrpl" : "base"}-${b.tx_hash}`,
    issued_at: opts.issuedAt,
    issuer: { name: "Lumi", methodology_url: `${base}/v1/trust/methodology`, methodology_version: "v0" },
    seller: { ...(b.kind === "vendor" ? { vendor_id: b.ref } : {}), endpoint, ...(domain ? { domain } : {}), pay_to: chain.pay_to },
    payment: {
      network: b.network as ReceiptNetwork,
      asset: b.asset,
      ...(chain.iou_issuer ? { issuer: chain.iou_issuer } : {}),
      amount: String(Number(b.amount)),
      ...(atomic != null && Number.isFinite(atomic) ? { amount_atomic: atomic } : {}),
      tx_hash: b.tx_hash,
      payer: chain.payer,
      ledger_result: chain.ledger_result,
      ...(chain.ledger_index != null ? { ledger_index: chain.ledger_index } : {}),
      ...(chain.block_number != null ? { block_number: chain.block_number } : {}),
    },
    delivery: {
      observed_at: new Date(b.ts).toISOString(),
      http_status: b.http_status ?? 0,
      data_returned: b.data_returned,
      outcome: outcomeOf(b.http_status, b.data_returned, b.summary),
      ...(b.latency_ms != null ? { latency_ms: b.latency_ms } : {}),
      source: b.kind === "catalog" ? "Lumi catalog test-buy (Base USDC)" : b.source === "lumi_buy" ? "Lumi paid buy (seeded)" : "Lumi daily test-buy (XRPL)",
    },
  };
}
