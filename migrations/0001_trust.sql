-- Trust layer v0 (Lumi API 0.6.0). D1 database: lumi_trust.

-- Free, unpaid 402-quote checks (cron, every 30 min). No payment is ever sent.
CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts INTEGER NOT NULL,              -- ms since epoch
  http_status INTEGER,              -- null = network error / timeout
  ok INTEGER NOT NULL,              -- 1 = valid x402 402 quote with an xrpl:0 option paying an allowlisted address
  price TEXT,
  asset TEXT,
  pay_to TEXT,
  source_tag INTEGER,               -- 1 = quote carries extra.sourceTag
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS probes_vendor_ts ON probes (vendor_id, ts);

-- Lumi's own paid test-buys (seeded from 2026-10-22 buys; then the owner-run daily script).
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  http_status INTEGER,
  data_returned INTEGER NOT NULL,
  latency_ms INTEGER,
  summary TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_vendor_ts ON observations (vendor_id, ts);

-- Agent reports. Only rows with verified = 1 are shown or scored.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  reporter TEXT NOT NULL,
  tx_ts INTEGER,
  amount TEXT,
  asset TEXT,
  http_status INTEGER,
  outcome TEXT NOT NULL,
  excerpt TEXT,                     -- private, never served
  signed INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  reason TEXT,
  ip_hash TEXT,
  ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_verified_tx ON reports (tx_hash) WHERE verified = 1;
CREATE INDEX IF NOT EXISTS reports_vendor_ts ON reports (vendor_id, ts);

-- Vendor replies (signed from the vendor's pay-to address, or added by the owner from email).
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  text TEXT NOT NULL,
  via TEXT NOT NULL,                -- 'signed:<address>' or 'email'
  verified INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_vendor ON replies (vendor_id, ts);

-- Tips: private. No endpoint, MCP tool or A2A skill reads this table.
CREATE TABLE IF NOT EXISTS tips (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  coins TEXT,
  urls TEXT,
  ip_hash TEXT,
  ts INTEGER NOT NULL
);

-- Fixed-window rate-limit counters (key = bucket:window:salted-ip-hash).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
