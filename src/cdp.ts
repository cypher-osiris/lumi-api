/**
 * Coinbase Developer Platform (CDP) API-key auth for the hosted x402 facilitator, Workers-native (Web Crypto only).
 *
 * Every request carries `Authorization: Bearer <JWT>`: an EdDSA (Ed25519) JWT signed with the CDP secret API key,
 * bound to one request (`uris: ["POST api.cdp.coinbase.com/platform/v2/x402/settle"]`) and valid for 120 s. Same claims
 * and header as @coinbase/cdp-sdk `generateJwt` (kid = key id, random hex nonce, iss "cdp", sub = key id).
 * The secret is base64 of 64 bytes (32-byte Ed25519 seed + 32-byte public key); it is imported once per isolate as a
 * non-extractable JWK and never logged.
 */

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

export interface CdpCredentials {
  keyId: string;
  keySecret: string;
}

const enc = new TextEncoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (v: unknown) => b64urlBytes(enc.encode(JSON.stringify(v)));

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

/** Import the Ed25519 signing key (cached per isolate). Throws if the secret is not a 64-byte base64 Ed25519 key. */
export function importCdpKey(secret: string): Promise<CryptoKey> {
  if (cached && cached.secret === secret) return cached.key;
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("CDP key secret is not base64");
  }
  if (raw.length !== 64) throw new Error("CDP key secret must be a base64 Ed25519 key (64 bytes); EC/PEM keys are not supported");
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64urlBytes(raw.subarray(0, 32)), x: b64urlBytes(raw.subarray(32)) };
  const key = crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  key.catch(() => {
    if (cached?.key === key) cached = null;
  });
  cached = { secret, key };
  return key;
}

/** A request-bound CDP JWT for `method url` (url = full https URL; query string excluded from the claim). */
export async function cdpJwt(creds: CdpCredentials, method: string, url: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const u = new URL(url);
  const header = { alg: "EdDSA", kid: creds.keyId, typ: "JWT", nonce: hex(crypto.getRandomValues(new Uint8Array(16))) };
  const claims = { sub: creds.keyId, iss: "cdp", uris: [`${method.toUpperCase()} ${u.host}${u.pathname}`], iat: nowS, nbf: nowS, exp: nowS + 120 };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const key = await importCdpKey(creds.keySecret);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(signingInput)));
  return `${signingInput}.${b64urlBytes(sig)}`;
}

/** Headers for one authenticated CDP request. */
export async function cdpAuthHeaders(creds: CdpCredentials, method: string, url: string): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await cdpJwt(creds, method, url)}`,
    "Correlation-Context": "sdkLanguage=typescript,source=lumi-api",
  };
}

/** Decode CDP's EXTENSION-RESPONSES header (base64 JSON, e.g. {"bazaar":{"status":"success"}}). Null when absent/garbled. */
export function decodeExtensionResponses(h: string | null): Record<string, unknown> | null {
  if (!h) return null;
  try {
    const bin = atob(h.trim());
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
