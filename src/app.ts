/**
 * Request router. Runtime-agnostic: `createApp(env)` returns a fetch handler
 * used by the Worker entry (src/index.ts) and the Node server (src/node.ts).
 */

import { setPrivateNames } from "./sanitize";
import { loadConfig, EXPLORERS, dropsToXrp, type Config, type Env, type PaidRoute } from "./config";
import { DataSource, type DataFile } from "./data";
import { makeReplayGuard, json, requirePayment, assetLabel, type PaywallDeps, type PaymentRequirements, type Quote, type Settlement } from "./x402";
import { PAID_ENDPOINTS } from "./catalog";
import { indexDoc, openApi, skillMd, wellKnownX402, VERSION } from "./docs";
import {
  coinList, resolveCoin, signalView, levelsView, slateView, marketView, DISCLAIMER, SOURCE, type CoinRef,
} from "./views";
import { staleInputs, hasContent } from "./freshness";
import { briefView, yenView, sentimentView, eventsView, tradesView } from "./products";

export interface AppOptions {
  fetch?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
  /** Clock (ms), injectable for tests. */
  now?: () => number;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  config: Config;
}

const NEEDS: Record<PaidRoute, DataFile[]> = {
  signal: ["signals", "prices"],
  levels: ["analysis", "prices"],
  slate: ["trades"],
  market: ["analysis", "signals", "prices", "context"],
  brief: ["prices", "context", "analysis", "signals", "trades"],
  yen: ["context", "analysis", "prices"],
  sentiment: ["context", "prices", "signals"],
  events: ["analysis"],
  trades: ["trades"],
};
/** Inputs that enrich a product but whose absence does not block it (the field is simply omitted). */
const OPTIONAL: Partial<Record<PaidRoute, DataFile[]>> = {
  brief: ["events", "brief"],
  yen: ["events"],
  events: ["events"],
};
/** Paid paths without a {coin} parameter. */
const FIXED: Record<string, PaidRoute> = {
  "/v1/slate": "slate",
  "/v1/market": "market",
  "/v1/brief": "brief",
  "/v1/macro/yen": "yen",
  "/v1/sentiment": "sentiment",
  "/v1/events": "events",
  "/v1/trades": "trades",
};

export function createApp(env: Env, opts: AppOptions = {}): App {
  const config = loadConfig(env);
  setPrivateNames(env.PRIVATE_NAMES);
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const data = new DataSource(config.dataBaseUrl, config.dataTtlMs, doFetch);
  const deps: PaywallDeps = {
    fetch: doFetch,
    replay: makeReplayGuard({ durableObject: env.INVOICE_GUARD, kv: env.USED_INVOICES }),
    log: opts.log ?? ((e) => console.log(JSON.stringify(e))),
  };

  async function coins(): Promise<CoinRef[]> {
    try {
      return coinList(await data.get("coins"));
    } catch {
      return coinList(undefined);
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const base = config.publicBaseUrl ?? url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
    }

    // ---------------- free
    switch (path) {
      case "/":
        return json(200, indexDoc(config, base, await coins()));
      case "/health":
        return json(200, {
          status: "ok",
          version: VERSION,
          network: config.network,
          pay_to: config.payTo,
          facilitator: config.facilitatorUrl,
          timestamp: new Date().toISOString(),
        });
      case "/skill.md":
      case "/SKILL.md":
      case "/llms.txt":
        return new Response(skillMd(config, base, await coins()), {
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
        });
      case "/.well-known/x402":
        return json(200, wellKnownX402(config, base), { "Cache-Control": "public, max-age=300" });
      case "/openapi.json":
        return json(200, openApi(config, base, await coins()), { "Cache-Control": "public, max-age=300" });
      case "/v1/coins": {
        const list = await coins();
        return json(200, {
          kind: "coins",
          timestamp: new Date().toISOString(),
          source: SOURCE,
          count: list.length,
          coins: list.map((c) => ({
            ...c,
            signal: `${base}/v1/signal/${c.symbol}`,
            levels: `${base}/v1/levels/${c.symbol}`,
          })),
          disclaimer: DISCLAIMER,
        });
      }
    }

    // ---------------- paid
    const m = path.match(/^\/v1\/(signal|levels)\/([^/]+)$/) ?? (FIXED[path] ? [path, FIXED[path]] : null);
    if (!m) return json(404, { error: "not_found", hint: `See ${base}/ for the endpoint list.` });
    const route = m[1] as PaidRoute;

    let coin: CoinRef | undefined;
    if (m[2] !== undefined) {
      coin = resolveCoin(await coins(), m[2]);
      if (!coin) {
        return json(404, {
          error: "unknown_coin",
          coin: m[2],
          supported: (await coins()).map((c) => c.symbol),
          note: "Not charged.",
        });
      }
    }

    // Load (cached) data before asking for money, so a payment is never
    // settled when the upstream data is unavailable.
    let loaded: Record<string, unknown>;
    try {
      loaded = { ...(await data.getOptional(OPTIONAL[route] ?? [])), ...(await data.getMany(NEEDS[route])) };
    } catch (err) {
      return json(503, { error: "data_unavailable", detail: String((err as Error).message), retryable: true, note: "Not charged." }, { "Retry-After": "30" });
    }
    const t = now();
    const stale = staleInputs(loaded, NEEDS[route], t, config.dataMaxAgeHours);
    if (stale.length) {
      return json(503, { error: "data_stale", detail: "Lumi's published data is missing or out of date, so this call is not for sale right now.", inputs: stale, retryable: true, note: "Not charged." }, { "Retry-After": "300" });
    }
    // Optional inputs that are stale are dropped (their fields are omitted), never served as current.
    for (const f of OPTIONAL[route] ?? []) if (staleInputs(loaded, [f], t, config.dataMaxAgeHours).length) delete loaded[f];
    const list = await coins();
    const body = buildBody(route, coin, loaded, list, t);
    if (body && !hasContent(route, body)) {
      return json(503, { error: "data_unavailable", detail: `the ${route} data is empty right now`, retryable: true, note: "Not charged." }, { "Retry-After": "300" });
    }
    if (!body) {
      return coin
        ? json(404, { error: "no_data_for_coin", coin: coin.symbol, note: "Not charged." })
        : json(503, { error: "data_unavailable", detail: `no ${route} data published right now`, retryable: true, note: "Not charged." }, { "Retry-After": "300" });
    }
    const wantsMarkdown =
      route === "brief" && (/^(md|markdown|text)$/i.test(url.searchParams.get("format") ?? "") || /text\/markdown/i.test(request.headers.get("Accept") ?? ""));

    const endpoint = PAID_ENDPOINTS.find((e) => e.route === route)!;
    const quote: Quote = {
      routeKey: coin ? `${route}:${coin.symbol}` : route,
      amountDrops: config.pricesDrops[route],
      amountsIou: Object.fromEntries(config.ious.map((o) => [o.symbol, o.prices[route]])),
      description: `Lumi API ${endpoint.template.replace("{coin}", coin?.symbol ?? "")}: ${endpoint.summary}`,
      resourceUrl: `${base}${path}`,
    };

    return requirePayment(request, config, deps, quote, (s: Settlement, paid: PaymentRequirements) => {
      const payment = {
        transaction: s.transaction,
        network: s.network,
        payer: s.payer ?? null,
        asset: assetLabel(paid),
        amount: paid.asset === "XRP" ? dropsToXrp(paid.amount) : paid.amount,
        ...(paid.asset === "XRP" ? { amount_drops: paid.amount } : { issuer: paid.extra?.issuer }),
        explorer: s.transaction ? `${EXPLORERS[config.network]}${s.transaction}` : null,
      };
      if (wantsMarkdown) {
        const md = String((body as { markdown?: string }).markdown ?? "");
        return new Response(`${md}\n_Paid: ${payment.amount} ${payment.asset}, tx ${payment.explorer ?? payment.transaction}_\n`, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-RESPONSE" },
        });
      }
      return json(200, { ...body, payment });
    });
  }

  return {
    config,
    async fetch(request: Request): Promise<Response> {
      try {
        return await handle(request);
      } catch (err) {
        console.error(JSON.stringify({ event: "unhandled_error", error: String(err) }));
        return json(500, { error: "internal_error" });
      }
    },
  };
}

function buildBody(route: PaidRoute, coin: CoinRef | undefined, d: Record<string, any>, coins: CoinRef[], now: number) {
  switch (route) {
    case "signal":
      return signalView(coin!, d.signals, d.prices);
    case "levels":
      return levelsView(coin!, d.analysis, d.prices);
    case "slate":
      return slateView(d.trades, coins);
    case "market":
      return marketView(d.analysis, d.signals, d.prices, d.context, coins);
    case "brief":
      return briefView(d as any, coins, now);
    case "yen":
      return yenView(d.context, d.analysis, d.events, d.prices, now);
    case "sentiment":
      return sentimentView(d.context, d.prices, d.signals, coins);
    case "events":
      return eventsView(d.events, d.analysis, coins, now);
    case "trades":
      return tradesView(d.trades, coins);
  }
}
