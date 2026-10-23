-- Idempotent retries for paid routes: an Idempotency-Key header (or the x402 payment-identifier extension id) plus the same
-- payment returns the cached response instead of charging again. Keys are stored hashed; rows expire after 24 h.

CREATE TABLE IF NOT EXISTS idempotency (
  key_hash TEXT PRIMARY KEY,           -- sha256 of the client's key
  payment_hash TEXT NOT NULL,          -- sha256 of the payment (invoice id)
  route TEXT NOT NULL,                 -- quote routeKey
  status INTEGER NOT NULL,
  headers TEXT NOT NULL,               -- JSON {content-type, payment-response}
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_expires ON idempotency (expires_at);
