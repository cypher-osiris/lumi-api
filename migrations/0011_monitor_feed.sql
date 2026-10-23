-- Seller monitoring (paid plans, seller-funded test-buys, append-only findings) and the data licence feed (hashed keys,
-- metered usage). None of these tables is read by any trust score: paying never changes a score.

CREATE TABLE IF NOT EXISTS monitor_enrollments (
  id TEXT PRIMARY KEY,                 -- men_<hex>
  network TEXT NOT NULL,               -- xrpl:0 | eip155:8453
  pay_to TEXT NOT NULL,                -- case-preserved
  pay_to_lc TEXT NOT NULL,
  domain TEXT,
  proof TEXT NOT NULL,                 -- JSON {challenge, signature, public_key?, signer}
  nonce TEXT NOT NULL UNIQUE,          -- challenge nonce (single use)
  endpoints TEXT NOT NULL,             -- JSON [{url, method, body?, price_usd, asset, checked_at}]
  webhook_url TEXT,
  webhook_secret TEXT,
  email TEXT,                          -- private, never shown publicly
  token_hash TEXT NOT NULL,            -- sha256 of the seller's management token
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_enroll_payto ON monitor_enrollments (pay_to_lc);

CREATE TABLE IF NOT EXISTS monitor_plans (
  id TEXT PRIMARY KEY,                 -- mpl_<hex>
  enrollment_id TEXT NOT NULL,
  plan TEXT NOT NULL,                  -- monitor | monitor_plus | audit
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  paid_tx TEXT NOT NULL UNIQUE,
  paid_network TEXT NOT NULL,
  paid_asset TEXT NOT NULL,
  paid_amount TEXT NOT NULL,
  payer TEXT,
  usd REAL,
  budget_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  is_test INTEGER NOT NULL DEFAULT 0,
  reminded INTEGER NOT NULL DEFAULT 0, -- 1 = renewal reminder sent, 2 = lapse notice sent
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_plans_enroll ON monitor_plans (enrollment_id, ends_at);
CREATE INDEX IF NOT EXISTS monitor_plans_ends ON monitor_plans (ends_at);

CREATE TABLE IF NOT EXISTS monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  network TEXT,
  tx_hash TEXT,
  amount TEXT,
  asset TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  http_status INTEGER,
  data_returned INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  outcome TEXT NOT NULL,               -- delivered | no_data | invalid_data | error_status | timeout | quote_failed | skipped
  quote_pay_to TEXT,
  quote_price_usd TEXT,
  schema_hash TEXT,
  note TEXT,
  funding TEXT NOT NULL DEFAULT 'seller-funded'
);
CREATE INDEX IF NOT EXISTS monitor_runs_enroll ON monitor_runs (enrollment_id, ts);

CREATE TABLE IF NOT EXISTS monitor_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id TEXT NOT NULL,
  endpoint TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- paid_no_data | paid_invalid_data | http_5xx | timeout | pay_to_changed | price_changed | schema_changed | recovered | plan_lapsed | renewal_due
  detail TEXT NOT NULL,
  run_id INTEGER,
  delivered TEXT                       -- comma list: webhook,email
);
CREATE INDEX IF NOT EXISTS monitor_findings_enroll ON monitor_findings (enrollment_id, ts);

CREATE TABLE IF NOT EXISTS monitor_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id TEXT NOT NULL,
  finding_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_replies_enroll ON monitor_replies (enrollment_id);

CREATE TABLE IF NOT EXISTS monitor_reports (
  plan_id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL,
  report TEXT NOT NULL,                -- canonical JSON
  report_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  public_key TEXT NOT NULL,
  signer TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Public correction log (append-only).
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,
  ref TEXT
);

-- Data licence feed.
CREATE TABLE IF NOT EXISTS feed_keys (
  id TEXT PRIMARY KEY,                 -- fk_<hex> (public key id)
  key_hash TEXT NOT NULL UNIQUE,       -- sha256 of the secret key
  wallet TEXT,                         -- proven (signup) or paying wallet
  wallet_lc TEXT,
  network TEXT,
  plan TEXT NOT NULL DEFAULT 'free',   -- free | feed | feed_pro
  plan_ends_at INTEGER,
  credits INTEGER NOT NULL DEFAULT 0,  -- prepaid metered lookups
  is_test INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  webhook_secret TEXT,
  webhook_cursor INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS feed_keys_wallet ON feed_keys (wallet_lc);

CREATE TABLE IF NOT EXISTS feed_usage (
  key_id TEXT NOT NULL,
  month TEXT NOT NULL,                 -- YYYY-MM (UTC)
  lookups INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  minute INTEGER NOT NULL DEFAULT 0,   -- unix minute of the rate-limit bucket
  minute_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, month)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS feed_payments (
  tx TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  product TEXT NOT NULL,               -- feed | feed_pro | feed_credits
  usd REAL,
  is_test INTEGER NOT NULL DEFAULT 0,
  network TEXT,
  asset TEXT,
  amount TEXT,
  payer TEXT,
  ts INTEGER NOT NULL
);

-- Status changes of catalogued resources (quote validity, payTo match, price match), for delta + Pro webhooks.
CREATE TABLE IF NOT EXISTS feed_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  resource TEXT NOT NULL,
  field TEXT NOT NULL,
  old TEXT,
  new TEXT
);
CREATE INDEX IF NOT EXISTS feed_changes_ts ON feed_changes (ts);
