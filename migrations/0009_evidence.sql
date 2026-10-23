-- Free trust evidence (no purchases): Bazaar quality fields, on-chain payer census (XRPL on demand, Base forward index),
-- vet402 open data (CC BY 4.0, kept apart from Lumi's own purchase-verified counts) and the demand-driven test-buy queue.
-- Workers Free / D1 Free: no secondary indexes here (PK lookups only), writes counted against the daily budget in code.

-- (a) CDP Bazaar quality: lastCalledAt and when the quality fields were last refreshed (they change daily; the listing sig does not).
ALTER TABLE catalog ADD COLUMN last_called_at INTEGER;
ALTER TABLE catalog ADD COLUMN quality_at INTEGER;

-- (b) XRPL payTo census, computed by a queued job and cached (doc = JSON, see src/trust/evidence.ts).
CREATE TABLE IF NOT EXISTS payto_census (
  network TEXT NOT NULL,
  pay_to TEXT NOT NULL,                -- case-preserved (XRPL addresses are case-sensitive)
  checked_at INTEGER NOT NULL,         -- 0 = queued, not computed yet
  queued_at INTEGER,
  doc TEXT,
  PRIMARY KEY (network, pay_to)
) WITHOUT ROWID;

-- (c) Base USDC Transfer logs to catalogued payTos, recorded going forward and aggregated per (payTo, payer).
CREATE TABLE IF NOT EXISTS base_inflow (
  pay_to TEXT NOT NULL,                -- lowercased
  payer TEXT NOT NULL,                 -- lowercased Transfer `from`
  n INTEGER NOT NULL,
  units INTEGER NOT NULL,              -- USDC base units (6 decimals)
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  first_block INTEGER NOT NULL,
  last_tx TEXT,
  PRIMARY KEY (pay_to, payer)
) WITHOUT ROWID;

-- Funding account of a payer (who first sent it funds), for clustering payers that share a funder.
CREATE TABLE IF NOT EXISTS funders (
  network TEXT NOT NULL,               -- xrpl:0 | eip155:8453
  account TEXT NOT NULL,               -- lowercased for EVM, case-preserved for XRPL
  funder TEXT,                         -- null = not found in the searched window
  checked_at INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (network, account)
) WITHOUT ROWID;

-- Payers whose funder is not resolved yet (small work list; avoids scanning base_inflow).
CREATE TABLE IF NOT EXISTS funder_todo (
  payer TEXT PRIMARY KEY,
  first_block INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);

-- (d) vet402 observatory open data (KIZUNA Creation, CC BY 4.0), one row per resource key (host + path, no scheme).
CREATE TABLE IF NOT EXISTS ext_vet402 (
  resource_key TEXT PRIMARY KEY,
  network TEXT,
  l0_verdict TEXT,                     -- published_verdict: pass | fail | unverified
  l0_probed_at INTEGER,
  listed INTEGER,
  l1_attempts INTEGER,
  l1_settled INTEGER,
  l1_delivered INTEGER,
  l1_last_at INTEGER,
  l1_last_status TEXT,
  l1_last_http INTEGER,
  l1_last_tx TEXT,
  retrieved_at INTEGER NOT NULL
) WITHOUT ROWID;

-- (e) Demand-driven test-buy queue: a paid trust/check of a catalogued resource with suspicious signals and no recent
-- purchase evidence queues it for the box's daily test-buy routine (daily cap applies there). Network-agnostic, so
-- XRPL buys staged elsewhere can be merged in later (catalog_buys already accepts xrpl:0 rows).
CREATE TABLE IF NOT EXISTS buy_queue (
  resource TEXT PRIMARY KEY,
  network TEXT,                        -- preferred network for the buy (eip155:8453 | xrpl:0 | other)
  price_usd TEXT,
  reasons TEXT NOT NULL,               -- comma-separated reason codes at the latest request
  hits INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | bought | skipped
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  note TEXT
) WITHOUT ROWID;
