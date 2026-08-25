PRAGMA foreign_keys = ON;

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('bug', 'feature')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  revenuecat_user_id TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE tip_intents (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  revenuecat_user_id TEXT NOT NULL,
  product_id TEXT NOT NULL CHECK (product_id IN ('whip_tip_small', 'whip_tip_medium', 'whip_tip_large')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_transaction_id TEXT
);

CREATE INDEX tip_intents_match_idx
  ON tip_intents(revenuecat_user_id, product_id, completed, created_at DESC);

CREATE TABLE tips (
  transaction_id TEXT PRIMARY KEY,
  tip_intent_id TEXT NOT NULL UNIQUE REFERENCES tip_intents(id),
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  revenuecat_user_id TEXT NOT NULL,
  product_id TEXT NOT NULL CHECK (product_id IN ('whip_tip_small', 'whip_tip_medium', 'whip_tip_large')),
  amount REAL,
  currency TEXT,
  store TEXT,
  environment TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX tips_request_idx ON tips(request_id, created_at DESC);
