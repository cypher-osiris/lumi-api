-- D1 write budget (Oct 23 2026): the private request log wrote one raw row per request (3 rows written each with the
-- ts index and AUTOINCREMENT), ~45k rows/day at current bot traffic, and helped exhaust the D1 Free 100k/day limit.
-- Requests are now counted in memory per isolate and flushed as ONE aggregate row per flush (every ~2 minutes or
-- 500 requests, whichever first): per-path / status / client / User-Agent / Referer host / country counts and the
-- set of daily-rotating IP hashes seen. Same privacy rules: no raw IPs, no query strings, /mcp/<key> -> /mcp/:key.
-- The legacy raw table `traffic` is no longer written; the owner summary reads both until its rows age out (90 days).
CREATE TABLE IF NOT EXISTS traffic_batches (
  ts INTEGER NOT NULL,       -- flush time, ms since epoch
  id TEXT NOT NULL,          -- random per flush (isolates may flush in the same ms)
  day TEXT NOT NULL,         -- YYYY-MM-DD (UTC) of every request in the batch
  doc TEXT NOT NULL,         -- JSON TrafficBatch counts
  PRIMARY KEY (ts, id)
) WITHOUT ROWID;
