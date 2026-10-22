-- Trust layer: the x402 catalog (CDP Bazaar discovery), free rotating 402-quote checks and purchase evidence.
-- Labels: entries with a valid recent quote are "quote-verified, low confidence"; entries with a Lumi
-- test-buy confirmed on-chain are "purchase-verified". Neutral observations only.

-- Workers Free / D1 Free (100k rows written per day, index entries count as writes): one secondary index only,
-- no AUTOINCREMENT, and a daily write budget enforced in code (src/trust/catalog_service.ts).
CREATE TABLE IF NOT EXISTS catalog (
  id INTEGER PRIMARY KEY,
  resource TEXT NOT NULL UNIQUE,      -- resource URL, scheme + host lowercased (see normalizeUrl)
  domain TEXT NOT NULL,               -- lowercase hostname, no leading www.
  reg_domain TEXT,                    -- registrable domain (example.com for api.example.com)
  pay_tos TEXT,                       -- all payTo values, lowercased, comma-separated
  method TEXT NOT NULL DEFAULT 'GET',
  body TEXT,                          -- example JSON body for POST probes (from the Bazaar listing)
  networks TEXT,                      -- comma-separated CAIP-2 networks
  price_usd TEXT,                     -- listed USDC price on Base (or first USD stablecoin option)
  accepts TEXT,                       -- compact JSON of the listed accepts (network, asset, amount, payTo)
  service_name TEXT,
  description TEXT,                   -- trimmed to 300 chars
  calls_30d INTEGER,                  -- Bazaar quality.l30DaysTotalCalls at last refresh
  payers_30d INTEGER,
  source TEXT NOT NULL,               -- cdp_bazaar
  sig TEXT,                           -- listing signature (changes only when the listing changes)
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,         -- last refresh that still listed it (refreshed at least every 6 days)
  -- free quote checks
  probe_ts INTEGER,
  probe_status INTEGER,
  probe_valid INTEGER,                -- 1 = answered a readable x402 402 quote
  probe_pay_to_match INTEGER,         -- 1 = the quote pays a listed payTo
  probe_price_usd TEXT,
  probe_price_match INTEGER,          -- 1 = quoted USD price equals the listing
  probe_latency_ms INTEGER,
  probe_error TEXT,
  probe_hist TEXT,                    -- last 30 results, newest first: 1 = valid quote, 0 = not
  probe_lat_hist TEXT                 -- last 7 latencies of valid quotes, comma-separated
);
CREATE INDEX IF NOT EXISTS catalog_reg_domain ON catalog (reg_domain);

-- Every payTo a listing advertises (lowercased), for payTo lookups.
CREATE TABLE IF NOT EXISTS catalog_payto (
  pay_to_lc TEXT NOT NULL,
  resource TEXT NOT NULL,
  PRIMARY KEY (pay_to_lc, resource)
) WITHOUT ROWID;

-- Registrable-domain age (RDAP), checked at most monthly.
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  registered_at INTEGER,
  checked_at INTEGER NOT NULL,
  error TEXT
);

-- Lumi test-buys of catalog resources, each confirmed on-chain before it is stored.
CREATE TABLE IF NOT EXISTS catalog_buys (
  id INTEGER PRIMARY KEY,
  resource TEXT NOT NULL,
  domain TEXT NOT NULL,
  ts INTEGER NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  facilitator TEXT,
  http_status INTEGER,
  data_returned INTEGER NOT NULL,
  latency_ms INTEGER,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_buys_resource ON catalog_buys (resource);
CREATE INDEX IF NOT EXISTS catalog_buys_domain ON catalog_buys (domain);

-- Small key/value state (rotation cursor, last ingest run).
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
