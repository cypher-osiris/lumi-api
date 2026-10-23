/**
 * Wallet-control proofs for seller enrolment and free feed keys: a stateless, HMAC-protected challenge the wallet signs.
 * XRPL: ripple-keypairs over the UTF-8 hex of the message (master key, or the account's current regular key).
 * Base: EIP-191 personal_sign. Single use is enforced by the caller storing the nonce (UNIQUE column).
 */
import { EVM_ADDR_RE, XRPL_ADDR_RE, recoverEvmSigner, verifyXrplSignature, xrplAddressOf, xrplRegularKey, type Fetch } from "../trust/verify";
import { hmacHex, randHex } from "./plans";

export const CHALLENGE_TTL_MS = 15 * 60_000;
export type ProofPurpose = "monitor-enroll" | "feed-key";

export function networkOf(address: string): "xrpl:0" | "eip155:8453" | null {
  if (XRPL_ADDR_RE.test(address)) return "xrpl:0";
  if (EVM_ADDR_RE.test(address)) return "eip155:8453";
  return null;
}

const macInput = (p: string, n: string, a: string, nonce: string, exp: string) => `${p}|${n}|${a}|${nonce}|${exp}`;

export async function makeChallenge(secret: string, purpose: ProofPurpose, address: string, now: number) {
  const network = networkOf(address);
  if (!network) return null;
  const nonce = randHex(12);
  const exp = new Date(now + CHALLENGE_TTL_MS).toISOString();
  const addr = network === "eip155:8453" ? address.toLowerCase() : address;
  const mac = (await hmacHex(secret, macInput(purpose, network, addr, nonce, exp))).slice(0, 32);
  const message = [
    `lumi-${purpose}`,
    `address: ${addr}`,
    `network: ${network}`,
    `nonce: ${nonce}`,
    `expires: ${exp}`,
    `mac: ${mac}`,
    "Signing proves control of this address for api.lumitrades.io. It is not a payment and moves no funds.",
  ].join("\n");
  return { message, network, address: addr, nonce, expires_at: exp };
}

export type ProofResult = { ok: true; address: string; network: "xrpl:0" | "eip155:8453"; nonce: string; signer: string } | { ok: false; reason: string };

export async function verifyProof(
  secret: string,
  purpose: ProofPurpose,
  input: { message?: unknown; signature?: unknown; public_key?: unknown },
  now: number,
  f: Fetch,
  xrplRpc: string[],
): Promise<ProofResult> {
  const message = typeof input.message === "string" ? input.message : "";
  const signature = typeof input.signature === "string" ? input.signature.trim() : "";
  if (!message || !signature) return { ok: false, reason: "message_and_signature_required" };
  const lines = message.split("\n");
  const field = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? "";
  if (lines[0] !== `lumi-${purpose}`) return { ok: false, reason: "wrong_challenge_purpose" };
  const address = field("address"), network = field("network"), nonce = field("nonce"), exp = field("expires"), mac = field("mac");
  if (!address || !nonce || !exp || !mac || (network !== "xrpl:0" && network !== "eip155:8453")) return { ok: false, reason: "malformed_challenge" };
  const want = (await hmacHex(secret, macInput(purpose, network, address, nonce, exp))).slice(0, 32);
  if (want !== mac) return { ok: false, reason: "challenge_not_issued_by_lumi" };
  if (!(Date.parse(exp) > now)) return { ok: false, reason: "challenge_expired" };
  if (network === "eip155:8453") {
    const signer = recoverEvmSigner(message, signature);
    if (!signer || signer !== address.toLowerCase()) return { ok: false, reason: "signature_not_from_address" };
    return { ok: true, address, network, nonce, signer };
  }
  const pk = typeof input.public_key === "string" ? input.public_key.trim() : "";
  if (!pk) return { ok: false, reason: "public_key_required_for_xrpl" };
  if (!verifyXrplSignature(message, signature, pk)) return { ok: false, reason: "bad_signature" };
  const derived = xrplAddressOf(pk);
  if (derived === address) return { ok: true, address, network, nonce, signer: derived };
  // Regular key: the account's current RegularKey must be the key that signed.
  const rk = await xrplRegularKey(f, xrplRpc, address).catch(() => undefined);
  if (rk === undefined) return { ok: false, reason: "ledger_unavailable_retry" };
  if (rk && derived && rk === derived) return { ok: true, address, network, nonce, signer: derived };
  return { ok: false, reason: "signing_key_does_not_control_address" };
}
