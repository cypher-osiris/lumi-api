-- Private request log (Lumi API 0.9.1): one row per request, for the owner-only GET /v1/owner/traffic.
-- No raw IPs: ip_hash is HMAC-SHA256(server secret, day | ip), truncated, so it rotates daily and cannot be reversed.
-- No query strings or headers beyond a truncated User-Agent and the Referer host. Rows older than 90 days are pruned by cron.
CREATE TABLE IF NOT EXISTS traffic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- ms since epoch
  day TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
  method TEXT NOT NULL,
  path TEXT NOT NULL,           -- pathname only; /mcp/<key> is stored as /mcp/:key
  status INTEGER NOT NULL,
  ua TEXT,                      -- first 160 chars
  ua_class TEXT,                -- browser | bot | ai-agent | sdk | cli | other
  ref_host TEXT,                -- Referer host only
  ip_hash TEXT,                 -- daily-rotating keyed hash, never the IP
  country TEXT,
  is_402 INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS traffic_ts ON traffic (ts);
