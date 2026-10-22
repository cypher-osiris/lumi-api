/**
 * Request router. Runtime-agnostic: `createApp(env)` returns a fetch handler
 * used by the Worker entry (src/index.ts) and the Node server (src/node.ts).
 */

import { setPrivateNames } from "./sanitize";
import { loadConfig, EXPLORERS, type Config, type Env, type PaidRoute } from "./config";
import { DataSource, type DataFile } from "./data";
import { makeReplayGuard, json, requirePayment, type PaywallDeps, type Quote, type Settlement } from "./x402";
import { PAID_ENDPOINTS } from "./catalog";
import { indexDoc, openApi, skillMd, wellKnownX402, VERSION } from "./docs";
import {
  coinList, resolveCoin, signalView, levelsView, slateView, marketView, DISCLAIMER, SOURCE, type CoinRef,
} from "./views";

export interface AppOptions {
  fetch?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
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
};

export function createApp(env: Env, opts: AppOptions = {}): App {
  const config = loadConfig(env);
  setPrivateNames(env.PRIVATE_NAMES);
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
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
    const m = path.match(/^\/v1\/(signal|levels)\/([^/]+)$/) ?? path.match(/^\/v1\/(slate|market)$/);
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
      loaded = await data.getMany(NEEDS[route]);
    } catch (err) {
      return json(503, { error: "data_unavailable", detail: String((err as Error).message), retryable: true, note: "Not charged." }, { "Retry-After": "30" });
    }
    const list = await coins();
    const body = buildBody(route, coin, loaded, list);
    if (!body) return json(404, { error: "no_data_for_coin", coin: coin?.symbol, note: "Not charged." });

    const endpoint = PAID_ENDPOINTS.find((e) => e.route === route)!;
    const quote: Quote = {
      routeKey: coin ? `${route}:${coin.symbol}` : route,
      amountDrops: config.pricesDrops[route],
      description: `Lumi API ${endpoint.template.replace("{coin}", coin?.symbol ?? "")}: ${endpoint.summary}`,
      resourceUrl: `${base}${path}`,
    };

    return requirePayment(request, config, deps, quote, (s: Settlement) =>
      json(200, {
        ...body,
        payment: {
          transaction: s.transaction,
          network: s.network,
          payer: s.payer ?? null,
          amount_drops: quote.amountDrops,
          explorer: s.transaction ? `${EXPLORERS[config.network]}${s.transaction}` : null,
        },
      }),
    );
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

function buildBody(route: PaidRoute, coin: CoinRef | undefined, d: Record<string, any>, coins: CoinRef[]) {
  switch (route) {
    case "signal":
      return signalView(coin!, d.signals, d.prices);
    case "levels":
      return levelsView(coin!, d.analysis, d.prices);
    case "slate":
      return slateView(d.trades, coins);
    case "market":
      return marketView(d.analysis, d.signals, d.prices, d.context, coins);
  }
}
