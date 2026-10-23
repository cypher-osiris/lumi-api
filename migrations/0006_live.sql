-- Live mechanical signals (Lumi API 0.11.0): one row per coin in the top-50 universe, refreshed by the one-minute cron.
CREATE TABLE IF NOT EXISTS live_signals (
  id TEXT PRIMARY KEY,           -- CoinGecko id
  computed_at INTEGER NOT NULL,  -- ms since epoch (1h/4h recomputed)
  daily_at INTEGER NOT NULL,     -- ms since epoch (1d recomputed)
  doc TEXT NOT NULL              -- JSON LiveRow
);
