-- Money is stored as integer minor units (amount_cents); negative = money out.
-- All timestamps are ISO 8601 UTC text.
--
-- `subcategory` holds a taxonomy leaf (src/ingest/taxonomy.ts); its parent
-- category is derived in code and never stored.

CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT,
  institution  TEXT,
  currency     TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, external_id)
);

-- Category columns: `subcategory` is the effective leaf every reader uses,
-- resolved in code by resolveEffectiveCategories() from a transaction
-- override, then a description rule, then the machine label. `machine_subcategory`
-- is what the categoriser wrote; `category_origin` says which of the three
-- produced the effective value. Corrections never touch is_subscription or the
-- transfer flags.
CREATE TABLE transactions (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source               TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  posted_at            TEXT NOT NULL,
  executed_at          TEXT,
  amount_cents         INTEGER NOT NULL,
  currency             TEXT NOT NULL,
  description_raw      TEXT NOT NULL,
  description_norm     TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'posted')),
  subcategory          TEXT,
  category_source      TEXT CHECK (category_source IN ('llm', 'manual')),
  machine_subcategory  TEXT,
  category_origin      TEXT CHECK (category_origin IN ('llm', 'transaction_override', 'description_rule')),
  is_subscription      INTEGER CHECK (is_subscription IN (0, 1)),
  is_internal_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_internal_transfer IN (0, 1)),
  transfer_source      TEXT CHECK (transfer_source IN ('pair', 'heuristic')),
  transfer_pair_id     INTEGER,
  raw_json             TEXT NOT NULL,
  ingested_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, external_id)
);

CREATE INDEX idx_transactions_posted_at ON transactions (posted_at);
CREATE INDEX idx_transactions_account_posted_at ON transactions (account_id, posted_at);
CREATE INDEX idx_transactions_subcategory ON transactions (subcategory);
CREATE INDEX idx_transactions_description_norm ON transactions (description_norm);

-- Dedup cache: one categorisation per normalised description, not per transaction.
CREATE TABLE description_categories (
  description_norm TEXT PRIMARY KEY,
  subcategory      TEXT NOT NULL,
  confidence       REAL,
  transfer_hint    INTEGER NOT NULL DEFAULT 0 CHECK (transfer_hint IN (0, 1)),
  is_subscription  INTEGER CHECK (is_subscription IN (0, 1)),
  model            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per file import. account_id is the account the file was imported
-- into, null until the source has resolved it (or when it was since deleted);
-- "last import per account" in the status display is derived from here.
-- Row counts: inserted is new transactions, updated is rows that already
-- existed by (source, external_id), skipped is rows the source could not map
-- plus rows whose account was unknown.
CREATE TABLE import_runs (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  account_id     INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at    TEXT,
  rows_inserted  INTEGER NOT NULL DEFAULT 0,
  rows_updated   INTEGER NOT NULL DEFAULT 0,
  rows_skipped   INTEGER NOT NULL DEFAULT 0,
  -- How many existing rows the file left unchanged and how many rows in the
  -- file repeated an earlier row's id. NULL when a run did not measure them.
  rows_unchanged INTEGER,
  rows_duplicate INTEGER,
  status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'ok', 'error')),
  error          TEXT
);

CREATE INDEX idx_import_runs_account ON import_runs (account_id, id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Saved web conversations.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  backend_spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversations_activity ON conversations(updated_at DESC, id DESC);

CREATE TABLE conversation_messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','interrupted')),
  termination_reason TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id, request_id, role)
);
CREATE INDEX conversation_transcript ON conversation_messages(conversation_id, id);
CREATE UNIQUE INDEX assistant_request_id ON conversation_messages(request_id) WHERE role = 'assistant';

-- Balances are point-in-time observations, so they get a history table rather
-- than columns on accounts. as_of is the observation time: for a file that
-- carries a balance without a timestamp, that is the import's start time.
CREATE TABLE account_balances (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  as_of           TEXT NOT NULL,
  current_cents   INTEGER NOT NULL,
  available_cents INTEGER,
  currency        TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, as_of)
);

-- User corrections to the taxonomy label, kept apart from the machine label so
-- a correction can be removed and the next applicable label restored.

-- One override per transaction. Cascades with the row it corrects.
CREATE TABLE transaction_category_overrides (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions (id) ON DELETE CASCADE,
  subcategory    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One rule per source and exact normalised description. Applies to every
-- stored and future transaction of that source with that description.
CREATE TABLE description_category_rules (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL,
  description_norm TEXT NOT NULL,
  subcategory      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, description_norm)
);
