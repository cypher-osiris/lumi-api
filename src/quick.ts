/**
 * Stage C products: cheap, focused reads (lite signal, all-coins scan, funding, Fear & Greed, next-48h events) and the
 * "should I pay this x402 URL?" verdict. Mechanical readings and observations only; not financial advice.
 */
import { envelope, type CoinRef } from "./views";
import { compact, eventRows, catalystRows } from "./products";
import { band } from "./feeds";
import type { LiveRow } from "./live";

type Json = any;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// ---------------------------------------------------------------- lite signal
/** Lite read: label, score, price, 1h/4h/1d labels. Built from the full signal body. */
export function liteView(full: Json) {
  const tf = (k: string) => (full?.timeframes?.[k] ? { label: full.timeframes[k].label ?? null, score: num(full.timeframes[k].score) } : null);
  return envelope("signal_lite", compact({
    coin: full?.coin,
    label: full?.label ?? null,
    score: num(full?.score),
    price: { usd: num(full?.price?.usd), change_24h_pct: num(full?.price?.change_24h_pct) },
    timeframes: { "1h": tf("1h"), "4h": tf("4h"), "1d": tf("1d") },
    computed: full?.computed ?? "site",
    full_read: `GET /v1/signal/${full?.coin?.symbol ?? "{coin}"} adds the per-indicator breakdown (RSI, MACD, EMA, Bollinger, StochRSI, volume) and 24h range.`,
  }));
}

// ---------------------------------------------------------------- scan
const ORDER = ["Strong Buy", "Buy", "Neutral", "Sell", "Strong Sell"];

/** Every fresh live row, strongest score first, with label counts. */
export function scanView(rows: LiveRow[], universe: CoinRef[]) {
  const sorted = [...rows].sort((a, b) => (b.score ?? -9) - (a.score ?? -9));
  const counts = Object.fromEntries(ORDER.map((l) => [l, sorted.filter((r) => r.label === l).length]));
  const have = new Set(rows.map((r) => r.id));
  const bull = counts["Strong Buy"] + counts["Buy"], bear = counts["Sell"] + counts["Strong Sell"];
  return envelope("scan", {
    count: sorted.length,
    universe: universe.length,
    label_counts: counts,
    breadth: { bullish: bull, neutral: counts["Neutral"], bearish: bear, read: bull > bear * 1.5 ? "broadly bullish" : bear > bull * 1.5 ? "broadly bearish" : "mixed" },
    coins: sorted.map((r) => ({
      symbol: r.symbol,
      id: r.id,
      label: r.label,
      score: r.score,
      tf: { "1h": r.timeframes["1h"]?.label ?? null, "4h": r.timeframes["4h"]?.label ?? null, "1d": r.timeframes["1d"]?.label ?? null },
      rsi_1h: num(r.timeframes["1h"]?.indicators?.rsi?.value),
      price_usd: num(r.price?.usd),
      change_24h_pct: num(r.price?.change_24h_pct),
      computed_at: new Date(r.computed_at).toISOString(),
    })),
    missing: universe.filter((c) => !have.has(c.id)).map((c) => c.symbol),
    method: "Same mechanical 1h/4h/1d indicator score as GET /v1/signal/{coin}, computed live from public exchange candles (1h refreshed about every 13 minutes). Coins without a fresh reading are listed in missing.",
  });
}

// ---------------------------------------------------------------- funding
function fundingRead(rate8h: number) {
  if (rate8h >= 0.05) return "longs paying a lot: crowded long";
  if (rate8h >= 0.015) return "longs paying: mildly long-leaning";
  if (rate8h > -0.015) return "near neutral";
  if (rate8h > -0.05) return "shorts paying: mildly short-leaning";
  return "shorts paying a lot: crowded short";
}

export function fundingView(doc: Json) {
  const coins: Json[] = Array.isArray(doc?.coins) ? doc.coins : [];
  if (!coins.length) return null;
  const rows = coins.map((c) => ({ ...c, read: fundingRead(c.rate_8h_pct) })).sort((a, b) => b.rate_8h_pct - a.rate_8h_pct);
  const btc = rows.find((c) => c.symbol === "BTC");
  const sorted8 = rows.map((c) => c.rate_8h_pct).sort((a, b) => a - b);
  const median = sorted8[Math.floor(sorted8.length / 2)];
  return envelope("funding", {
    venue: doc.venue,
    count: rows.length,
    btc: btc ?? null,
    median_rate_8h_pct: median,
    summary: `${btc ? `BTC funding ${btc.rate_8h_pct}% per 8h (${btc.read}). ` : ""}Median across ${rows.length} coins ${median}% per 8h (${fundingRead(median)}).`,
    most_positive: rows.slice(0, 5).map((c) => ({ symbol: c.symbol, rate_8h_pct: c.rate_8h_pct })),
    most_negative: rows.slice(-5).reverse().map((c) => ({ symbol: c.symbol, rate_8h_pct: c.rate_8h_pct })),
    coins: rows,
    note: "rate_pct is the current period's rate; rate_8h_pct normalises it to 8 hours; annualized_pct = rate x periods per year. Positive = longs pay shorts. Positioning context, not a prediction.",
  });
}

// ---------------------------------------------------------------- fear & greed
export function fearGreedView(doc: Json) {
  const v = num(doc?.now?.value);
  if (v == null) return null;
  const y = num(doc?.yesterday?.value), w = num(doc?.last_week?.value), m = num(doc?.last_month?.value);
  return envelope("fear_greed", compact({
    source: "CoinMarketCap",
    value: v,
    classification: band(v),
    at: doc.now.at,
    yesterday: doc.yesterday, last_week: doc.last_week, last_month: doc.last_month,
    year_high: doc.year_high, year_low: doc.year_low,
    change: { vs_yesterday: y == null ? null : v - y, vs_last_week: w == null ? null : v - w, vs_last_month: m == null ? null : v - m },
    series_30d: doc.series_30d,
    bands: "0-20 Extreme fear, 20-40 Fear, 40-60 Neutral, 60-80 Greed, 80-100 Extreme greed",
  }));
}

/** Fallback when the live feed is unavailable: the site's CoinMarketCap snapshot (context.json). */
export function fearGreedFromContext(context: Json) {
  const fg = context?.fear_greed;
  if (fg?.source !== "CoinMarketCap" || num(fg?.value) == null || fg.stale) return null;
  return fearGreedView({ now: { value: fg.value, at: fg.timestamp }, yesterday: fg.previous != null ? { value: fg.previous, classification: band(fg.previous) } : null });
}

// ---------------------------------------------------------------- next 48h events
export function events48View(events: Json, analysis: Json, coins: CoinRef[], now: number) {
  const end = now + 48 * 3_600_000;
  const timed = eventRows(events, now).filter((e) => Date.parse(e.at_utc) >= now && Date.parse(e.at_utc) <= end);
  const lastDay = new Date(end).toISOString().slice(0, 10);
  const byDate = analysis ? catalystRows(analysis, coins, now).filter((c) => c.date <= lastDay) : [];
  if (!timed.length && !byDate.length && !events) return null;
  return envelope("events_48h", compact({
    window: { from: new Date(now).toISOString(), to: new Date(end).toISOString() },
    count: timed.length + byDate.length,
    next: timed[0] ?? null,
    timed,
    by_date: byDate,
    note: timed.length + byDate.length
      ? "Scheduled releases and decisions in the next 48 hours (UTC + US Central), each with its source. Dates can move; check the source."
      : "Nothing sourced and scheduled in the next 48 hours.",
  }));
}

// ---------------------------------------------------------------- should I pay this x402 URL?
export interface CheckInput { url: string; payTo?: string; amountUsd?: number; network?: string }
interface Reason { code: string; severity: "block" | "warn" | "info"; detail: string }

/**
 * Verdict from Lumi's observations (CDP Bazaar listing + free quote checks + paid test-buys):
 * block = a concrete red flag (payTo or price differs from the listing, Lumi paid and got nothing);
 * warn = not enough evidence (unlisted, unchecked, failing quotes, young domain, slow);
 * allow = listed and its quotes check out (purchase-verified = Lumi paid and got data).
 */
export function trustVerdict(input: CheckInput, exact: Json | null, domainDoc: Json | null, base: string) {
  const reasons: Reason[] = [];
  const add = (code: string, severity: Reason["severity"], detail: string) => reasons.push({ code, severity, detail });
  const exactEntries: Json[] = exact?.catalog?.entries ?? [];
  const domEntries: Json[] = domainDoc?.catalog?.entries ?? [];
  const self = exact?.self ?? domainDoc?.self;
  const e = exactEntries[0] ?? null;
  const curated: Json[] = [...(exact?.curated ?? []), ...(domainDoc?.curated ?? [])];

  if (self) {
    add("lumi_itself", "info", "This is Lumi's own API; Lumi does not score itself.");
  } else if (!e && !domEntries.length && !curated.length) {
    add("not_observed", "warn", "Not in the CDP x402 Bazaar catalog Lumi ingests (refreshed daily) or Lumi's curated list. No observation is not proof of a problem, but there is no evidence either.");
  } else if (!e && !domEntries.length) {
    add("curated_vendor", "info", `In Lumi's curated XRPL vendor list (${curated[0].name}), which Lumi probes every 30 minutes and test-buys; see ${curated[0].detail}.`);
    const xb = (curated[0].purchases ?? [])[0];
    const n = curated[0].xrpl_test_buys;
    if (xb) {
      if (xb.data_returned === false) add("xrpl_paid_no_data", "warn", `Lumi's latest XRPL test-buy (${xb.at}, tx ${xb.tx_hash}) paid ${xb.amount} ${xb.asset} and got no usable data (HTTP ${xb.http_status}); ${n?.delivered ?? 0} of ${n?.count ?? 0} XRPL test-buys in 30 days returned data.`);
      else add("xrpl_purchase_verified", "info", `Lumi paid ${xb.amount} ${xb.asset} on XRPL on ${xb.at} and got data back (tx ${xb.tx_hash}); ${n?.delivered ?? 0} of ${n?.count ?? 0} XRPL test-buys in 30 days returned data.`);
    } else add("no_recent_xrpl_buy", "warn", "No Lumi XRPL test-buy of this vendor in the last 30 days.");
  } else if (!e) {
    add("resource_not_listed", "warn", `This exact URL is not listed, but ${domEntries.length} listing(s) on the same domain are. Compare against those.`);
  }

  const ref = e ?? domEntries[0];
  const listedPayTo: string[] = [...new Set<string>([...(e ? [e] : domEntries)].flatMap((x) => (x.pay_to ?? []).map((p: Json) => String(p.pay_to).toLowerCase())))];
  if (input.payTo) {
    if (listedPayTo.length && !listedPayTo.includes(input.payTo.toLowerCase())) add("pay_to_mismatch", "block", `The payTo you were quoted (${input.payTo}) is not an address this ${e ? "resource" : "domain"} lists in the Bazaar (${listedPayTo.slice(0, 3).join(", ")}).`);
    else if (listedPayTo.length) add("pay_to_matches", "info", "The payTo you were quoted matches the listing.");
  }
  if (e) {
    const listed = Number(e.listed_price_usd);
    if (input.amountUsd != null && Number.isFinite(listed) && listed > 0 && input.amountUsd > listed * 1.5 && input.amountUsd - listed > 0.001) {
      add("price_above_listing", "block", `You were quoted $${input.amountUsd}, more than the listed $${e.listed_price_usd}.`);
    }
    const q = e.quote_checks;
    if (!q) add("not_quote_checked", "warn", "Listed, but Lumi has not quote-checked it yet.");
    else {
      if (q.last_valid_quote === false) add("last_quote_invalid", "warn", `Lumi's last free quote check (${q.last_checked_at}) did not get a valid x402 quote${q.last_note ? `: ${String(q.last_note).slice(0, 120)}` : ""}.`);
      if (q.last_quote_pays_listed_address === false) add("quote_pays_unlisted_address", "block", "At Lumi's last check the live 402 quote paid an address that is not in the listing.");
      if (q.last_price_matches_listing === false) add("quoted_price_differs", "warn", `At Lumi's last check the quoted price ($${q.last_quoted_price_usd}) differed from the listing ($${e.listed_price_usd}).`);
      if (typeof q.valid_quote_rate === "number" && q.checks_recorded >= 3 && q.valid_quote_rate < 0.5) add("unreliable_quotes", "warn", `Only ${Math.round(q.valid_quote_rate * 100)}% of ${q.checks_recorded} quote checks were valid.`);
      if (typeof q.median_latency_ms === "number" && q.median_latency_ms > 5000) add("slow", "warn", `Median quote latency ${q.median_latency_ms} ms.`);
    }
    const last = (e.purchases ?? [])[0];
    if (last) {
      if (last.data_returned === false) add("paid_no_data", "block", `Lumi's latest test-buy (${last.at}, tx ${last.tx_hash}) paid and got no usable data (HTTP ${last.http_status}).`);
      else add("purchase_verified", "info", `Lumi paid ${last.amount} ${last.asset} on ${last.at} and got data back (tx ${last.tx_hash}).`);
    }
    if (e.listed_until) add("delisted", "warn", `No longer in the Bazaar listing (last seen ${e.listed_until}).`);
  }
  const age = ref?.domain_age?.age_days;
  if (typeof age === "number" && age < 30) add("young_domain", "warn", `The domain was registered ${age} days ago.`);

  const verdict = self ? "allow" : reasons.some((r) => r.severity === "block") ? "block" : reasons.some((r) => r.severity === "warn") ? "warn" : "allow";
  if (verdict === "allow" && e && !reasons.some((r) => r.code === "purchase_verified")) add("quote_verified", "info", "Listed in the Bazaar and its recent free quote checks are valid.");
  const confidence = self ? "n/a" : e?.purchases?.length || (!e && curated.length) ? "medium" : e?.quote_checks ? "low" : "very low";
  const cur = curated[0];
  return envelope("trust_check", compact({
    query: compact({ url: input.url, payTo: input.payTo, amount_usd: input.amountUsd, network: input.network }),
    verdict,
    confidence,
    reasons,
    matched: ref ? compact({ resource: ref.resource, domain: ref.domain, tier: ref.tier, listed_price_usd: ref.listed_price_usd, pay_to: (ref.pay_to ?? []).slice(0, 4), last_quote_check: ref.quote_checks?.last_checked_at, exact: !!e }) : null,
    next_steps: compact({
      free_lookup: `${base}/v1/trust/vendors?url=${encodeURIComponent(input.url)}`,
      full_report: cur?.id ? { url: `${base}/v1/trust/vendors/${cur.id}/report`, price_usd: "0.02", what: "every quote check and paid test-buy with tx hashes, latency trend, uptime %" } : null,
    }),
    note: "Observations, not a rating or a guarantee. block = a concrete mismatch or failed paid call; warn = not enough evidence; allow = listing and recent checks agree.",
  }));
}
