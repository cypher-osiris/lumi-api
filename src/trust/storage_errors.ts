/**
 * D1 quota / storage-limit errors (e.g. "D1_ERROR: Your account has exceeded D1's free tier daily row write limit ...").
 * These are temporary, Lumi-side storage failures: report them as 503 storage_unavailable (retryable) instead of an
 * opaque 500 internal_error, so a caller (like the daily test-buy ingest) can tell "not stored yet, retry later" apart
 * from a real bug. Nothing about the caller's request is judged by this.
 */
const QUOTA_RE = /D1_ERROR[^]*?(exceeded|limit|quota)/i;

export function isStorageQuotaError(e: unknown): boolean {
  return QUOTA_RE.test(String((e as any)?.message ?? e ?? ""));
}

/** Seconds until the next 00:00 UTC (when D1's free-tier daily limits reset), at least 60. */
export function secondsToUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - nowMs) / 1000));
}

export function storageUnavailableBody(nowMs: number) {
  const retryAfter = secondsToUtcMidnight(nowMs);
  return {
    body: { error: "storage_unavailable", reason: "storage_write_limit", retryable: true, retry_after_s: retryAfter, recorded: false, note: "Lumi-side storage limit; nothing was stored. Retry after the reset." },
    retryAfter,
  };
}
