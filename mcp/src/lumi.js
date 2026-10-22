/**
 * Lumi API client used by the MCP server: free calls, quotes (402 terms) and paid calls through x402-xrpl
 * with spend caps. No MCP code here, so it can be tested on its own.
 */
import { Wallet } from "xrpl";
import { x402Fetch, decodePaymentResponseHeader, XRPLPresignedPaymentPayer } from "x402-xrpl";

export const MAINNET_API = "https://api.lumitrades.io";
export const MAINNET_PAY_TO = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
const STABLES = {
  RLUSD: { currency: "524C555344000000000000000000000000000000" },
  USDC: { currency: "5553444300000000000000000000000000000000" },
};

/** Read and validate configuration from the environment. The seed is only held in memory, never logged or returned. */
export function loadSettings(env = process.env) {
  const network = env.XRPL_NETWORK || "xrpl:0";
  if (!["xrpl:0", "xrpl:1", "xrpl:2"].includes(network)) throw new Error(`XRPL_NETWORK must be xrpl:0, xrpl:1 or xrpl:2 (got ${network})`);
  const apiUrl = (env.LUMI_API_URL || MAINNET_API).replace(/\/+$/, "");
  const asset = (env.LUMI_PAY_ASSET || "XRP").toUpperCase();
  if (!["XRP", "RLUSD", "USDC"].includes(asset)) throw new Error("LUMI_PAY_ASSET must be XRP, RLUSD or USDC");
  const num = (v, d, name) => {
    const n = v === undefined || v === "" ? d : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  return {
    network,
    apiUrl,
    asset,
    seed: env.XRPL_SEED || "",
    wsUrl: env.XRPL_WS_URL || (network === "xrpl:0" ? "wss://xrplcluster.com" : "wss://testnet.xrpl-labs.com"),
    maxXrpPerCall: num(env.LUMI_MAX_XRP_PER_CALL, 0.05, "LUMI_MAX_XRP_PER_CALL"),
    maxUsdPerCall: num(env.LUMI_MAX_USD_PER_CALL, 0.05, "LUMI_MAX_USD_PER_CALL"),
    // Session budget across all paid calls in this server process, in the chosen asset (XRP or USD). 0 = no paid calls.
    budget: num(env.LUMI_SESSION_BUDGET, asset === "XRP" ? 1 : 1, "LUMI_SESSION_BUDGET"),
    // Only pay this address. Defaults to Lumi's mainnet wallet when talking to the official API on mainnet.
    expectedPayTo: env.LUMI_EXPECTED_PAY_TO || (apiUrl === MAINNET_API && network === "xrpl:0" ? MAINNET_PAY_TO : ""),
  };
}

const toNumber = (req) => (req.asset === "XRP" ? Number(req.amount) / 1e6 : Number(req.amount));

/**
 * Pick the accepts[] option for the configured asset and enforce: network, payTo, per-call cap, session budget.
 * Throws (so nothing is signed) when no option qualifies.
 */
export function makeSelector(settings, ledger) {
  return (accepts) => {
    ledger.lastError = null;
    const want =
      settings.asset === "XRP"
        ? (a) => a.asset === "XRP"
        : (a) => a.asset === STABLES[settings.asset].currency || a.extra?.symbol === settings.asset;
    const opt = accepts.find((a) => a.scheme === "exact" && a.network === settings.network && want(a));
    const fail = (msg) => {
      ledger.lastError = msg;
      return new SpendError(msg);
    };
    if (!opt) throw fail(`no ${settings.asset} option on ${settings.network} in the 402 quote`);
    if (settings.expectedPayTo && opt.payTo !== settings.expectedPayTo) {
      throw fail(`refusing to pay ${opt.payTo}: expected ${settings.expectedPayTo}`);
    }
    const amt = toNumber(opt);
    const cap = settings.asset === "XRP" ? settings.maxXrpPerCall : settings.maxUsdPerCall;
    if (!(amt > 0) || amt > cap) throw fail(`price ${amt} ${settings.asset} is above the per-call cap ${cap}`);
    if (ledger.spent + amt > settings.budget + 1e-12) {
      throw fail(`session budget ${settings.budget} ${settings.asset} would be exceeded (spent ${round(ledger.spent)})`);
    }
    ledger.pending = amt;
    return opt;
  };
}

export class SpendError extends Error {}
const round = (n) => Math.round(n * 1e6) / 1e6;

export function createClient(settings, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const ledger = { spent: 0, pending: 0, calls: [], lastError: null };
  let paidFetch = null;

  function payer() {
    if (!settings.seed) return null;
    if (!paidFetch) {
      paidFetch = (deps.x402Fetch ?? x402Fetch)({
        wallet: Wallet.fromSeed(settings.seed),
        network: settings.network,
        wsUrl: settings.wsUrl,
        paymentRequirementsSelector: makeSelector(settings, ledger),
        // Sign locally (the seed never leaves this process); record signing errors, which the SDK would otherwise swallow.
        paymentHeaderFactory: async (reqs, ctx) => {
          try {
            const p = new XRPLPresignedPaymentPayer({ wallet: Wallet.fromSeed(settings.seed), network: reqs.network, wsUrl: settings.wsUrl, invoiceBinding: "both" });
            return await p.createPaymentHeader(reqs, ctx);
          } catch (e) {
            ledger.lastError = `could not sign the payment: ${e?.message ?? e}`;
            throw e;
          }
        },
        fetchImpl,
      });
    }
    return paidFetch;
  }

  async function readBody(res) {
    const type = res.headers.get("content-type") || "";
    const text = await res.text();
    if (type.includes("json")) {
      try {
        return JSON.parse(text);
      } catch {
        /* fall through */
      }
    }
    return text;
  }

  return {
    settings,
    ledger,
    walletAddress: () => (settings.seed ? Wallet.fromSeed(settings.seed).classicAddress : null),

    /** Free GET (index, coins, health, discovery). */
    async free(path) {
      const res = await fetchImpl(settings.apiUrl + path, { headers: { Accept: "application/json" } });
      return { status: res.status, body: await readBody(res) };
    },

    /** Unpaid GET of a paid path: returns the 402 terms (prices per asset) without paying. */
    async quote(path) {
      const res = await fetchImpl(settings.apiUrl + path, { headers: { Accept: "application/json" } });
      const body = await readBody(res);
      if (res.status !== 402) return { status: res.status, body };
      return {
        status: 402,
        resource: body.resource?.url,
        description: body.resource?.description,
        options: (body.accepts || []).map((a) => ({
          asset: a.asset === "XRP" ? "XRP" : a.extra?.symbol ?? a.asset,
          amount: a.asset === "XRP" ? String(Number(a.amount) / 1e6) : a.amount,
          network: a.network,
          payTo: a.payTo,
        })),
      };
    },

    /** Paid GET: pays per the 402 quote with the user's wallet, within caps. */
    async paid(path, accept = "application/json") {
      const pf = payer();
      if (!pf) {
        const q = await this.quote(path);
        return { paid: false, status: q.status, error: "XRPL_SEED is not set, so no payment was made. Terms:", quote: q };
      }
      ledger.pending = 0;
      ledger.lastError = null;
      let res;
      try {
        res = await pf(settings.apiUrl + path, { headers: { Accept: accept } });
      } catch (e) {
        if (e instanceof SpendError || e?.cause instanceof SpendError) return { paid: false, error: `not paid: ${e.message}` };
        return { paid: false, error: `request failed before any confirmed payment: ${e?.message ?? e}` };
      }
      const body = await readBody(res);
      if (res.status === 402 && ledger.lastError) {
        return { paid: false, status: 402, error: `not paid: ${ledger.lastError}`, quote: body?.accepts ?? body };
      }
      const rh = res.headers.get("PAYMENT-RESPONSE");
      let receipt = null;
      if (rh) {
        try {
          receipt = decodePaymentResponseHeader(rh);
        } catch {
          receipt = null;
        }
      }
      if (res.status === 200 && receipt?.success) {
        ledger.spent = round(ledger.spent + ledger.pending);
        ledger.calls.push({ path, amount: ledger.pending, asset: settings.asset, tx: receipt.transaction });
      }
      return {
        paid: res.status === 200 && !!receipt?.success,
        status: res.status,
        body,
        receipt,
        spent_this_session: `${ledger.spent} ${settings.asset}`,
      };
    },
  };
}
