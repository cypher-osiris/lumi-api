-- Signed test-buy receipts (counterparty_delivery_receipt v0.1). One per test-buy tx (observations / catalog_buys).
CREATE TABLE IF NOT EXISTS receipts (
  tx_hash TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  kind TEXT NOT NULL,          -- vendor | catalog
  ref TEXT NOT NULL,           -- vendor_id or catalog resource key
  receipt_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,       -- full signed receipt JSON
  stored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_ref ON receipts (kind, ref);
