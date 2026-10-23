-- H-1 (Oct 23 2026): a test-buy where Lumi never saw an HTTP response (our client timed out, our run was interrupted)
-- is inconclusive, not "no data returned". Rows keep their original summary in summary_before; corrections are logged
-- in monitor_corrections and superseded receipts stay verifiable in receipts_superseded. Nothing is deleted.
ALTER TABLE catalog_buys ADD COLUMN inconclusive TEXT;      -- NULL = conclusive; else a reason code (delivery.ts)
ALTER TABLE catalog_buys ADD COLUMN corrected_at INTEGER;
ALTER TABLE catalog_buys ADD COLUMN summary_before TEXT;
ALTER TABLE observations ADD COLUMN inconclusive TEXT;
ALTER TABLE observations ADD COLUMN corrected_at INTEGER;
ALTER TABLE observations ADD COLUMN summary_before TEXT;

CREATE TABLE IF NOT EXISTS receipts_superseded (
  receipt_hash TEXT PRIMARY KEY,   -- hash of the receipt that is no longer current
  tx_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,           -- the full superseded receipt, kept verbatim
  superseded_at INTEGER NOT NULL,
  superseded_by TEXT NOT NULL,     -- receipt_hash of the current receipt
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_superseded_tx ON receipts_superseded (tx_hash);
