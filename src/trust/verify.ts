/**
 * On-ledger and signature checks for agent reports, vendor replies and owner observations.
 * Read-only: public JSON-RPC lookups and signature math. No keys are held here.
 */
import { verify as keypairVerify, deriveAddress } from "ripple-keypairs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { ed25519 } from "@noble/curves/ed25519";

export const RLUSD = { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" };
export const USDC_XRPL = { currency: "5553444300000000000000000000000000000000", issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE" };
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const RIPPLE_EPOCH = 946_684_800;

export const XRPL_TX_RE = /^[0-9A-F]{64}$/;
export const EVM_TX_RE = /^0x[0-9a-f]{64}$/;
export const XRPL_ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const STELLAR_TX_RE = /^[0-9a-f]{64}$/;
export const STELLAR_ADDR_RE = /^G[A-Z2-7]{55}$/;
export const STELLAR_NET = "stellar:pubnet";
/** Circle USDC on Stellar pubnet (classic issuer; its SAC is CCW67TSZ…MI75). */
export const STELLAR_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const STELLAR_HORIZON = "https://horizon.stellar.org";

export type Fetch = typeof fetch;

export interface LedgerPayment {
  hash: string;
  from: string;
  to: string;
  /** Decimal amount actually delivered (XRP, not drops; token units for IOUs/USDC). */
  amount: string;
  asset: string;
  ts: number;
  /** Public key that signed the tx (XRPL only; empty for multisig). */
  signingPubKey?: string;
}

export type LookupError =
  | "tx_not_found"
  | "tx_not_validated"
  | "tx_failed"
  | "not_a_payment"
  | "nothing_delivered"
  | "ledger_unavailable";

export type Lookup = { ok: true; payments: LedgerPayment[] } | { ok: false; reason: LookupError };

const hex = (bytes: Uint8Array) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
export const utf8Hex = (s: string) => hex(new TextEncoder().encode(s)).toUpperCase();

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

export function assetOfIou(a: { currency: string; issuer: string }): string {
  if (a.currency === RLUSD.currency && a.issuer === RLUSD.issuer) return "RLUSD";
  if (a.currency === USDC_XRPL.currency && a.issuer === USDC_XRPL.issuer) return "USDC";
  return `${a.currency}.${a.issuer}`;
}

export async function rpc(f: Fetch, url: string, body: unknown): Promise<any> {
  const r = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  return r.json();
}

/** Public Base RPCs tried after the configured one (some refuse or rate-limit requests from Workers). */
export const BASE_RPC_FALLBACKS = [
  "https://base.drpc.org",
  "https://gateway.tenderly.co/public/base",
  "https://1rpc.io/base",
  "https://base-mainnet.public.blastapi.io",
  "https://base.meowrpc.com",
  "https://base-rpc.publicnode.com", // last: refuses older-tx ("archive") lookups without a token
];

/** JSON-RPC against each URL in turn; a reply with a JSON-RPC error also moves on to the next URL. */
export async function rpcAny(f: Fetch, urls: string[], body: unknown): Promise<any> {
  let last: unknown = new Error("no rpc url");
  for (const u of urls) {
    try {
      const j = await rpc(f, u, body);
      if (j && j.error == null) return j;
      last = new Error("rpc error");
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Look up a validated XRPL Payment. Tries each RPC URL until one answers. */
export async function lookupXrplPayment(f: Fetch, urls: string[], hash: string): Promise<Lookup> {
  for (const url of urls) {
    let res: any;
    try {
      res = (await rpc(f, url, { method: "tx", params: [{ transaction: hash, binary: false, api_version: 2 }] }))?.result;
    } catch {
      continue;
    }
    if (!res) continue;
    if (res.error === "txnNotFound") return { ok: false, reason: "tx_not_found" };
    if (res.error) continue;
    if (!res.validated) return { ok: false, reason: "tx_not_validated" };
    const tx = res.tx_json ?? res;
    const meta = res.meta ?? {};
    if (meta.TransactionResult !== "tesSUCCESS") return { ok: false, reason: "tx_failed" };
    if (tx.TransactionType !== "Payment") return { ok: false, reason: "not_a_payment" };
    const d = meta.delivered_amount;
    let amount: string;
    let asset: string;
    if (typeof d === "string") {
      amount = String(Number(d) / 1e6);
      asset = "XRP";
    } else if (d && typeof d === "object" && d.value) {
      amount = String(d.value);
      asset = assetOfIou(d);
    } else return { ok: false, reason: "nothing_delivered" };
    if (!(Number(amount) > 0)) return { ok: false, reason: "nothing_delivered" };
    const ts = res.close_time_iso ? Date.parse(res.close_time_iso) : typeof tx.date === "number" ? (tx.date + RIPPLE_EPOCH) * 1000 : NaN;
    return {
      ok: true,
      payments: [{ hash: (res.hash ?? hash).toUpperCase(), from: tx.Account, to: tx.Destination, amount, asset, ts, signingPubKey: tx.SigningPubKey ?? "" }],
    };
  }
  return { ok: false, reason: "ledger_unavailable" };
}

/** The XRPL account's current RegularKey (if any). */
export async function xrplRegularKey(f: Fetch, urls: string[], account: string): Promise<string | null | undefined> {
  for (const url of urls) {
    try {
      const res = (await rpc(f, url, { method: "account_info", params: [{ account, ledger_index: "validated" }] }))?.result;
      if (res?.account_data) return res.account_data.RegularKey ?? null;
      if (res?.error === "actNotFound") return null;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Look up a successful Base tx and return its USDC Transfer logs. */
export async function lookupBaseUsdc(f: Fetch, url: string, hash: string): Promise<Lookup> {
  const urls = [url, ...BASE_RPC_FALLBACKS.filter((u) => u !== url)];
  let receipt: any;
  try {
    receipt = (await rpcAny(f, urls, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }))?.result;
  } catch {
    return { ok: false, reason: "ledger_unavailable" };
  }
  if (!receipt) return { ok: false, reason: "tx_not_found" };
  if (receipt.status !== "0x1") return { ok: false, reason: "tx_failed" };
  let ts = NaN;
  try {
    const block = (await rpcAny(f, urls, { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] }))?.result;
    ts = parseInt(block?.timestamp, 16) * 1000;
  } catch {
    return { ok: false, reason: "ledger_unavailable" };
  }
  const payments: LedgerPayment[] = [];
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== BASE_USDC || log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const value = BigInt(log.data);
    if (value <= 0n) continue;
    payments.push({
      hash: hash.toLowerCase(),
      from: "0x" + String(log.topics[1]).slice(-40).toLowerCase(),
      to: "0x" + String(log.topics[2]).slice(-40).toLowerCase(),
      amount: (Number(value) / 1e6).toString(),
      asset: "USDC",
      ts,
    });
  }
  if (!payments.length) return { ok: false, reason: "not_a_payment" };
  return { ok: true, payments };
}

/** XRPL signature over the UTF-8 bytes of `message` (ripple-keypairs `sign(utf8Hex(message), privateKey)`). */
export function verifyXrplSignature(message: string, signature: string, publicKey: string): boolean {
  try {
    return keypairVerify(utf8Hex(message), signature, publicKey);
  } catch {
    return false;
  }
}

export function xrplAddressOf(publicKey: string): string | null {
  try {
    return deriveAddress(publicKey);
  } catch {
    return null;
  }
}

/** Recover the signer of an EIP-191 personal_sign signature (lowercase 0x address), or null. */
export function recoverEvmSigner(message: string, signature: string): string | null {
  try {
    const sig = signature.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
    const msg = new TextEncoder().encode(message);
    const prefixed = new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]);
    const digest = keccak_256(prefixed);
    let v = parseInt(sig.slice(128, 130), 16);
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const pub = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    return "0x" + hex(keccak_256(pub.slice(1)).slice(-20));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Stellar

/** USDC moved by a successful Stellar pubnet tx: SEP-41 transfers (Horizon asset_balance_changes) and classic payments. */
export async function lookupStellarUsdc(f: Fetch, horizon: string, hash: string): Promise<Lookup> {
  const h = horizon.replace(/\/+$/, "");
  const get = async (path: string) => {
    const r = await f(`${h}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`horizon http ${r.status}`);
    return r.json() as Promise<any>;
  };
  let tx: any, ops: any;
  try {
    tx = await get(`/transactions/${hash}`);
    if (!tx) return { ok: false, reason: "tx_not_found" };
    if (tx.successful !== true) return { ok: false, reason: "tx_failed" };
    ops = await get(`/transactions/${hash}/operations?limit=50`);
  } catch {
    return { ok: false, reason: "ledger_unavailable" };
  }
  const ts = Date.parse(String(tx.created_at ?? ""));
  const payments: LedgerPayment[] = [];
  for (const op of ops?._embedded?.records ?? []) {
    const changes: any[] = op.type === "invoke_host_function" ? op.asset_balance_changes ?? [] :
      op.type === "payment" ? [{ type: "transfer", from: op.from, to: op.to, amount: op.amount, asset_code: op.asset_code, asset_issuer: op.asset_issuer }] : [];
    for (const c of changes) {
      if (c?.type !== "transfer" || c.asset_code !== "USDC" || c.asset_issuer !== STELLAR_USDC_ISSUER) continue;
      if (!(Number(c.amount) > 0)) continue;
      payments.push({ hash, from: String(c.from), to: String(c.to), amount: String(Number(c.amount)), asset: "USDC", ts });
    }
  }
  if (!payments.length) return { ok: false, reason: "not_a_payment" };
  return { ok: true, payments };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Raw 32-byte ed25519 public key of a Stellar G-address (StrKey, checksum verified), or null. */
export function stellarPublicKey(address: string): Uint8Array | null {
  if (!STELLAR_ADDR_RE.test(address)) return null;
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of address) {
    val = (val << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const raw = Uint8Array.from(out);
  if (raw.length !== 35 || raw[0] !== 6 << 3) return null;
  const crc = crc16xmodem(raw.slice(0, 33));
  if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8) return null;
  return raw.slice(1, 33);
}

/** Stellar signature: ed25519 over the UTF-8 bytes of `message` by the G-address's key; signature as base64 (stellar-sdk Keypair.sign). */
export function verifyStellarSignature(message: string, signatureB64: string, address: string): boolean {
  try {
    const pk = stellarPublicKey(address);
    if (!pk) return false;
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, new TextEncoder().encode(message), pk);
  } catch {
    return false;
  }
}
