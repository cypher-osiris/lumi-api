import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings, makeSelector, SpendError, MAINNET_PAY_TO } from "../src/lumi.js";

const accepts = (payTo = MAINNET_PAY_TO, drops = "20000") => [
  { scheme: "exact", network: "xrpl:0", asset: "XRP", amount: drops, payTo, extra: { invoiceId: "i" } },
  { scheme: "exact", network: "xrpl:0", asset: "524C555344000000000000000000000000000000", amount: "0.03", payTo, extra: { symbol: "RLUSD", issuer: "r" } },
  { scheme: "exact", network: "xrpl:0", asset: "5553444300000000000000000000000000000000", amount: "0.03", payTo, extra: { symbol: "USDC", issuer: "r" } },
];

test("defaults: mainnet, official API, pins Lumi's pay-to address", () => {
  const s = loadSettings({});
  assert.equal(s.network, "xrpl:0");
  assert.equal(s.expectedPayTo, MAINNET_PAY_TO);
  assert.equal(s.asset, "XRP");
});

test("picks the configured asset under the cap", () => {
  const ledger = { spent: 0, pending: 0 };
  assert.equal(makeSelector(loadSettings({}), ledger)(accepts()).asset, "XRP");
  assert.equal(ledger.pending, 0.02);
  assert.equal(makeSelector(loadSettings({ LUMI_PAY_ASSET: "RLUSD" }), ledger)(accepts()).extra.symbol, "RLUSD");
  assert.equal(makeSelector(loadSettings({ LUMI_PAY_ASSET: "usdc" }), ledger)(accepts()).extra.symbol, "USDC");
});

test("refuses: over per-call cap, wrong payee, over session budget, wrong network", () => {
  const ledger = { spent: 0, pending: 0 };
  assert.throws(() => makeSelector(loadSettings({ LUMI_MAX_XRP_PER_CALL: "0.01" }), ledger)(accepts()), SpendError);
  assert.throws(() => makeSelector(loadSettings({}), ledger)(accepts("rEvilEvilEvilEvilEvilEvilEvilEvil")), /refusing to pay/);
  assert.throws(() => makeSelector(loadSettings({ LUMI_SESSION_BUDGET: "0.03" }), { spent: 0.02, pending: 0 })(accepts()), /budget/);
  assert.throws(() => makeSelector(loadSettings({ XRPL_NETWORK: "xrpl:1", LUMI_API_URL: "http://x" }), ledger)(accepts()), /no XRP option/);
});

test("rejects bad settings", () => {
  assert.throws(() => loadSettings({ LUMI_PAY_ASSET: "BTC" }));
  assert.throws(() => loadSettings({ XRPL_NETWORK: "eip155:1" }));
  assert.throws(() => loadSettings({ LUMI_MAX_XRP_PER_CALL: "-1" }));
});
