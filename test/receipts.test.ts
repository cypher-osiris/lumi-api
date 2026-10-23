import { describe, it, expect } from "vitest";
import { deriveKeypair, deriveAddress, generateSeed, sign } from "ripple-keypairs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "../src/app";
import { buildReceiptBody, canonicalJson, receiptHash, receiptMessage, verifyReceipt, MemoryReceiptStore, type PendingBuy, type Receipt } from "../src/trust/receipts";
import { utf8Hex } from "../src/trust/verify";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52) };
const seed = generateSeed({ entropy: new Uint8Array(16).fill(7) });
const kp = deriveKeypair(seed);
const XADDR = deriveAddress(kp.publicKey);
const evm = privateKeyToAccount(generatePrivateKey());

const xbuy: PendingBuy = {
  kind: "vendor", ref: "example-vendor", endpoint: "https://seller.example/v1/data", domain: null, pay_to: null, ts: NOW - 3_600_000,
  network: "xrpl:0", tx_hash: "AB".repeat(32), amount: "0.006", asset: "RLUSD", http_status: 200, data_returned: true, latency_ms: 812, summary: "ok", source: "lumi_test_buy",
};
const bbuy: PendingBuy = {
  kind: "catalog", ref: "api.seller.example/v1/x", endpoint: "api.seller.example/v1/x", domain: "seller.example", pay_to: "0x00000000000000000000000000000000000000aa", ts: NOW - 7_200_000,
  network: "eip155:8453", tx_hash: "0x" + "cd".repeat(32), amount: "0.01", asset: "USDC", http_status: 200, data_returned: false, latency_ms: 300, summary: "empty list", source: "lumi_catalog_buy",
};

async function signX(b: PendingBuy): Promise<Receipt> {
  const body = buildReceiptBody(b, { payer: XADDR, pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", ledger_result: "tesSUCCESS", ledger_index: 100, iou_issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" }, { issuedAt: new Date(NOW).toISOString() });
  const h = await receiptHash(body);
  const message = receiptMessage(b.network, b.tx_hash, h);
  return { ...body, receipt_hash: h, signer: { key_type: "ripple-keypairs", address: XADDR, public_key: kp.publicKey, message, signature: sign(utf8Hex(message), kp.privateKey) } };
}
async function signB(b: PendingBuy): Promise<Receipt> {
  const body = buildReceiptBody(b, { payer: evm.address.toLowerCase(), pay_to: b.pay_to!, ledger_result: "success", block_number: 5 }, { issuedAt: new Date(NOW).toISOString() });
  const h = await receiptHash(body);
  const message = receiptMessage(b.network, b.tx_hash, h);
  return { ...body, receipt_hash: h, signer: { key_type: "eip191", address: evm.address, message, signature: await evm.signMessage({ message }) } };
}

describe("signed test-buy receipts", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined, d: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"d":{"y":2,"z":1}}');
  });

  it("verifies XRPL and Base receipts and rejects tampering", async () => {
    const x = await signX(xbuy);
    expect(x.delivery.outcome).toBe("delivered");
    expect((await verifyReceipt(x)).ok).toBe(true);
    const b = await signB(bbuy);
    expect(b.delivery.outcome).toBe("empty_result");
    expect(b.payment.amount_atomic).toBe(10000);
    expect((await verifyReceipt(b)).ok).toBe(true);
    const t = structuredClone(x); t.delivery.data_returned = false;
    const c = await verifyReceipt(t);
    expect(c.ok).toBe(false); expect(c.errors).toContain("hash_mismatch");
    const w = structuredClone(b); w.signer.address = "0x" + "11".repeat(20);
    expect((await verifyReceipt(w)).errors).toContain("signature_invalid");
  });

  it("labels the delivery source from the buy's own chain and asset (XRPL catalog buys are not 'Base USDC')", async () => {
    const xcat: PendingBuy = { ...xbuy, kind: "catalog", ref: "seller.example/v1/data", asset: "XRP", amount: "0.5", source: "lumi_catalog_buy" };
    const x = await signX(xcat);
    expect(x.delivery.source).toBe("Lumi catalog test-buy (XRPL XRP)");
    expect(x.delivery.source).not.toMatch(/Base|USDC/);
    expect((await verifyReceipt(x)).ok).toBe(true);
    expect((await signX({ ...xcat, asset: "RLUSD", amount: "0.01" })).delivery.source).toBe("Lumi catalog test-buy (XRPL RLUSD)");
    expect((await signB(bbuy)).delivery.source).toBe("Lumi catalog test-buy (Base USDC)");
    expect((await signX(xbuy)).delivery.source).toBe("Lumi daily test-buy (XRPL)");
  });

  it("owner upload stores only receipts matching a Lumi test-buy; free verify works; pending lists unsigned buys", async () => {
    const rs = new MemoryReceiptStore();
    rs.buys = [xbuy, bbuy];
    const app = createApp({ ...ENV, TRUST_BUYER_ADDRESSES: XADDR, TRUST_BUYER_EVM: evm.address } as any, { fetch: makeFetch(happyFacilitator()), now: () => NOW, receiptStore: rs });
    const auth = { Authorization: "Bearer " + "k".repeat(52), "Content-Type": "application/json" };
    const pend = await app.fetch(new Request("https://x.test/v1/trust/receipts/pending", { headers: auth }));
    expect((await pend.json() as any).pending.length).toBe(2);
    expect((await app.fetch(new Request("https://x.test/v1/trust/receipts/pending"))).status).toBe(401);
    const x = await signX(xbuy), b = await signB(bbuy);
    const bad = structuredClone(b); bad.payment.amount = "0.02"; // re-sign would be needed; hash breaks
    const up = await app.fetch(new Request("https://x.test/v1/trust/receipts", { method: "POST", headers: auth, body: JSON.stringify({ receipts: [x, b, bad] }) }));
    const uj = await up.json() as any;
    expect(uj.stored).toBe(2);
    expect(uj.results[2].stored).toBe(false);
    expect(await rs.count()).toBe(2);
    const v = await app.fetch(new Request("https://x.test/v1/trust/receipts/verify", { method: "POST", body: JSON.stringify(x) }));
    const vj = await v.json() as any;
    expect(vj.ok).toBe(true); expect(vj.issued_by_lumi).toBe(true);
    const doc = await (await app.fetch(new Request("https://x.test/v1/trust/receipts/verify"))).json() as any;
    expect(doc.kind).toBe("receipt_verification");
    expect(JSON.stringify(doc)).not.toMatch(/seed|privateKey/i);
  });

  it("rejects receipts signed by a wallet that is not Lumi's", async () => {
    const rs = new MemoryReceiptStore(); rs.buys = [bbuy];
    const app = createApp({ ...ENV, TRUST_BUYER_EVM: "0x" + "22".repeat(20) } as any, { fetch: makeFetch(happyFacilitator()), now: () => NOW, receiptStore: rs });
    const r = await app.fetch(new Request("https://x.test/v1/trust/receipts", { method: "POST", headers: { Authorization: "Bearer " + "k".repeat(52) }, body: JSON.stringify({ receipts: [await signB(bbuy)] }) }));
    expect((await r.json() as any).results[0].errors).toContain("payer_not_lumi_wallet");
  });
});
