-- Sales ledger (Lumi API 0.9.0): one row per settled x402 payment, written right after settlement succeeds.
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,              -- ms since epoch (settlement time)
  route TEXT NOT NULL,              -- paid route, e.g. signal, brief, vendor_report
  route_key TEXT,                   -- route + parameter, e.g. signal:XRP
  rail TEXT NOT NULL,               -- xrpl | base
  network TEXT NOT NULL,            -- xrpl:0 | eip155:8453 ...
  asset TEXT NOT NULL,              -- XRP | RLUSD | USDC
  amount TEXT NOT NULL,             -- decimal units of asset (XRP, not drops; USDC, not atomic)
  usd REAL,                         -- list price in USD for this route (stablecoin quote), for cross-rail totals
  payer TEXT,
  tx TEXT NOT NULL UNIQUE,
  facilitator TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 -- 1 = paid by one of Lumi's own wallets (test-buys, Bazaar refresh)
);
CREATE INDEX IF NOT EXISTS sales_ts ON sales (ts);
CREATE INDEX IF NOT EXISTS sales_route_ts ON sales (route, ts);
