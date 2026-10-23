-- Live market feeds (Lumi API 0.12.0): funding rates and CoinMarketCap Fear & Greed, refreshed by the one-minute cron.
CREATE TABLE IF NOT EXISTS live_feeds (
  id TEXT PRIMARY KEY,           -- funding | fear_greed
  fetched_at INTEGER NOT NULL,   -- ms since epoch
  doc TEXT NOT NULL              -- JSON
);
