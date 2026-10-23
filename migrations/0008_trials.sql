-- Free trial calls (Lumi API 1.0.0): one row per trial call served. Wallet addresses (public) and a daily-rotating keyed IP hash; no raw IPs.
CREATE TABLE IF NOT EXISTS trial_uses (
  nonce TEXT PRIMARY KEY,   -- one-time SIWX challenge nonce (HMAC-bound to the URL)
  wallet TEXT NOT NULL,     -- lowercase 0x address that signed
  ip_hash TEXT,             -- HMAC(secret, trial|day|ip), truncated
  day TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  route TEXT NOT NULL,
  ts INTEGER NOT NULL       -- ms since epoch
);
CREATE INDEX IF NOT EXISTS idx_trial_wallet ON trial_uses (wallet);
CREATE INDEX IF NOT EXISTS idx_trial_ip_day ON trial_uses (ip_hash, day);
CREATE INDEX IF NOT EXISTS idx_trial_day ON trial_uses (day);
