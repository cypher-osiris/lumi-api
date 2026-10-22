/**
 * "You only pay when you get data." Before any 402 quote (and therefore before any settlement), every input file a
 * route needs must be present, non-empty and recent. Otherwise the API answers 503 `data_stale` / `data_unavailable`
 * with "Not charged." and no payment is ever requested or settled.
 */

import type { DataFile, Json } from "./data";

const H = 3_600_000;

/** Where each published file keeps its generation time. */
export function fileTimestamp(file: DataFile, d: Json): string | null {
  const v =
    file === "prices" ? d?.updated_utc
    : file === "trades" ? (d?.tracked_utc ?? d?.evaluated_utc)
    : file === "analysis" ? d?.as_of
    : d?.generated_utc;
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * Max age per file. The site refreshes market data at least 4x a day (6 AM, 12 PM, 6 PM, 11 PM CT; the trade tracker
 * every 30 min), so the longest normal gap is ~7 h overnight; analysis is hand-written per update.
 */
export function maxAgeMs(file: DataFile, baseHours: number): number | null {
  switch (file) {
    case "prices":
    case "signals":
    case "context":
    case "trades":
      return baseHours * H;
    case "analysis":
    case "events":
    case "brief":
      return baseHours * 4 * H;
    default:
      return null; // coins.json: static list, no freshness requirement
  }
}

/** Files are present, non-empty objects, with a timestamp no older than their max age (and not absurdly in the future). */
export function staleInputs(loaded: Record<string, Json>, files: DataFile[], now: number, baseHours: number) {
  const problems: { file: string; problem: string; as_of?: string }[] = [];
  for (const f of files) {
    const d = loaded[f];
    if (!d || typeof d !== "object" || Object.keys(d).length === 0) {
      problems.push({ file: `${f}.json`, problem: "missing_or_empty" });
      continue;
    }
    const max = maxAgeMs(f, baseHours);
    if (max === null) continue;
    const ts = fileTimestamp(f, d);
    if (!ts) {
      problems.push({ file: `${f}.json`, problem: "no_timestamp" });
      continue;
    }
    const age = now - Date.parse(ts);
    if (age > max) problems.push({ file: `${f}.json`, problem: `stale (older than ${Math.round(max / H)}h)`, as_of: ts });
    else if (age < -H) problems.push({ file: `${f}.json`, problem: "timestamp_in_future", as_of: ts });
  }
  return problems;
}

/** Minimum real content each product must carry before it can be sold. */
export function hasContent(route: string, body: Json): boolean {
  if (!body || typeof body !== "object") return false;
  switch (route) {
    case "signal":
      return typeof body.label === "string" || Object.keys(body.timeframes ?? {}).length > 0;
    case "levels":
      return (body.support?.length ?? 0) + (body.resistance?.length ?? 0) > 0 || !!body.projection || !!body.commentary;
    case "slate":
      return Array.isArray(body.ideas) && (body.ideas.length > 0 || Object.keys(body.no_setup_notes ?? {}).length > 0 || body.recently_closed?.length > 0);
    case "market":
      return typeof body.btc_backdrop?.price?.usd === "number";
    case "brief":
      return typeof body.bitcoin?.usd === "number" && !!body.markdown;
    case "yen":
      return typeof body.usd_jpy?.price === "number" || typeof body.nikkei_225?.price === "number";
    case "sentiment":
      return typeof body.fear_greed?.value === "number";
    case "events":
      return (body.upcoming_timed?.length ?? 0) + (body.recent_24h?.length ?? 0) + (body.upcoming_by_date?.length ?? 0) > 0;
    case "trades":
      return Array.isArray(body.trades) && body.trades.length > 0;
    default:
      return false;
  }
}
