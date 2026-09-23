import type { Db } from './client.js';

/**
 * Every persistence concern lives here. Tools own their own read queries and do
 * not go through the repo.
 *
 * The input shapes below are structural: `NormalisedAccount` /
 * `NormalisedTransaction` satisfy them without the DB layer importing ingest.
 */

export interface AccountInput {
  source: string;
  externalId: string;
  name: string;
  type?: string | null;
  institution?: string | null;
  currency: string;
  raw: unknown;
}

export interface TransactionInput {
  source: string;
  externalId: string;
  /**
   * The account by its external id under `source`, or, when the caller has
   * already resolved it, the internal `accounts.id`. A file may be imported
   * into an account another source created, so the pipeline passes the id.
   */
  accountExternalId: string;
  accountId?: number;
  postedAt: string;
  executedAt?: string | null;
  amountCents: number;
  currency: string;
  descriptionRaw: string;
  descriptionNorm: string;
  status: 'pending' | 'posted';
  raw: unknown;
}

export interface BalanceInput {
  /** Internal `accounts.id`, resolved by the caller. */
  accountId: number;
  asOf: string;
  currentCents: number;
  availableCents?: number | null;
  currency: string;
  raw: unknown;
}

export interface AccountRow {
  id: number;
  source: string;
  external_id: string;
  name: string;
  type: string | null;
  institution: string | null;
  currency: string;
  raw_json: string;
  created_at: string;
}

export interface TransactionRow {
  id: number;
  account_id: number;
  source: string;
  external_id: string;
  posted_at: string;
  executed_at: string | null;
  amount_cents: number;
  currency: string;
  description_raw: string;
  description_norm: string;
  status: 'pending' | 'posted';
  /**
   * The effective taxonomy leaf every reader uses; the parent category is
   * derived, never stored. Resolved from the override, rule and machine label
   * by `resolveEffectiveCategories`.
   */
  subcategory: string | null;
  /** 'manual' when an override or rule produced `subcategory`. */
  category_source: 'llm' | 'manual' | null;
  /** What the categoriser wrote, kept so a correction can be removed. */
  machine_subcategory: string | null;
  category_origin: CategoryOrigin | null;
  /** Descriptive subscription hint; null means unknown, including before enrichment. */
  is_subscription: 0 | 1 | null;
  is_internal_transfer: 0 | 1;
  transfer_source: 'pair' | 'heuristic' | null;
  transfer_pair_id: number | null;
  /** User decision, independent of the categoriser and retained on re-import. */
  transfer_override: 0 | 1 | null;
  raw_json: string;
  ingested_at: string;
}

export type CategoryOrigin = 'llm' | 'transaction_override' | 'description_rule';

export interface ImportRunResult {
  /** Internal `accounts.id` the file was imported into, once the source resolved it. */
  accountId?: number | null;
  inserted: number;
  /** Existing rows whose source facts changed. */
  updated: number;
  /** Existing rows the file repeated with identical source facts; omitted means not measured. */
  unchanged?: number | null;
  /** Rows in the file that repeated an earlier row's id; only the first is written. */
  duplicates?: number | null;
  /** Rows the source could not map plus rows whose account was unknown. */
  skipped: number;
  status: 'ok' | 'error';
  error?: string | null;
}

export interface DescriptionCategoryInput {
  descriptionNorm: string;
  subcategory: string;
  confidence?: number | null;
  transferHint?: boolean;
  /** null when the description does not say either way. */
  isSubscription?: boolean | null;
  model?: string | null;
}

const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// --- accounts -------------------------------------------------------------

const UPSERT_ACCOUNT = `
  INSERT INTO accounts (source, external_id, name, type, institution, currency, raw_json)
  VALUES (@source, @external_id, @name, @type, @institution, @currency, @raw_json)
  ON CONFLICT (source, external_id) DO UPDATE SET
    name = excluded.name,
    type = excluded.type,
    institution = excluded.institution,
    currency = excluded.currency,
    raw_json = excluded.raw_json
  RETURNING id`;

/** Returns the account's internal id. */
export function upsertAccount(db: Db, account: AccountInput): number {
  const row = db.prepare<Record<string, unknown>, { id: number }>(UPSERT_ACCOUNT).get({
    source: account.source,
    external_id: account.externalId,
    name: account.name,
    type: account.type ?? null,
    institution: account.institution ?? null,
    currency: account.currency,
    raw_json: JSON.stringify(account.raw),
  });
  if (!row) {
    throw new Error(`upsertAccount returned no row for ${account.source}/${account.externalId}`);
  }
  return row.id;
}

export function getAccountIdByExternalId(
  db: Db,
  source: string,
  externalId: string,
): number | undefined {
  return db
    .prepare<[string, string], { id: number }>(
      'SELECT id FROM accounts WHERE source = ? AND external_id = ?',
    )
    .get(source, externalId)?.id;
}

// --- transactions ---------------------------------------------------------

/**
 * A re-import updates the facts the source owns and deliberately leaves the
 * enrichment columns (subcategory, category_source, machine_subcategory,
 * category_origin, is_subscription, is_internal_transfer, transfer_source,
 * transfer_pair_id) untouched. A description rule reaches a new row when the
 * pipeline re-resolves effective categories after the upsert.
 */
const UPSERT_TRANSACTION = `
  INSERT INTO transactions (
    account_id, source, external_id, posted_at, executed_at, amount_cents, currency,
    description_raw, description_norm, status, raw_json
  ) VALUES (
    @account_id, @source, @external_id, @posted_at, @executed_at, @amount_cents, @currency,
    @description_raw, @description_norm, @status, @raw_json
  )
  ON CONFLICT (source, external_id) DO UPDATE SET
    account_id = excluded.account_id,
    posted_at = excluded.posted_at,
    executed_at = excluded.executed_at,
    amount_cents = excluded.amount_cents,
    currency = excluded.currency,
    description_raw = excluded.description_raw,
    description_norm = excluded.description_norm,
    status = excluded.status,
    raw_json = excluded.raw_json`;

export class UnknownAccountError extends Error {
  constructor(
    readonly source: string,
    readonly accountExternalId: string,
  ) {
    super(`No account ${source}/${accountExternalId}; upsert its account before its transactions`);
    this.name = 'UnknownAccountError';
  }
}

export interface UpsertCounts {
  inserted: number;
  /** Existing rows whose stored source facts differ from the file's. */
  updated: number;
  /** Existing rows the file repeated exactly; the write refreshes raw_json only. */
  unchanged: number;
}

/** The persisted columns the source owns; a change to any of them is an update. */
const SOURCE_FACTS =
  'account_id, posted_at, executed_at, amount_cents, currency, description_raw, description_norm, status';
interface StoredSourceFacts {
  account_id: number;
  posted_at: string;
  executed_at: string | null;
  amount_cents: number;
  currency: string;
  description_raw: string;
  description_norm: string;
  status: string;
}

/**
 * Upserts a page of transactions in one SQLite transaction. Reports how many
 * rows were new, how many existing rows (by `(source, external_id)`) changed a
 * source fact, and how many were repeated unchanged, so a re-import of the
 * same export reads as unchanged rather than as rewritten. Counts compare the
 * stored facts with the file's, not the number of statements run; enrichment
 * columns are never part of the comparison.
 */
export function upsertTransactions(db: Db, batch: readonly TransactionInput[]): UpsertCounts {
  if (batch.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const stmt = db.prepare<Record<string, unknown>>(UPSERT_TRANSACTION);
  const exists = db.prepare<[string, string], StoredSourceFacts>(
    `SELECT ${SOURCE_FACTS} FROM transactions WHERE source = ? AND external_id = ?`,
  );
  const accountIds = new Map<string, number>();

  return db.transaction((rows: readonly TransactionInput[]) => {
    const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const tx of rows) {
      const key = `${tx.source} ${tx.accountExternalId}`;
      let accountId = tx.accountId ?? accountIds.get(key);
      if (accountId === undefined) {
        accountId = getAccountIdByExternalId(db, tx.source, tx.accountExternalId);
        if (accountId === undefined) throw new UnknownAccountError(tx.source, tx.accountExternalId);
        accountIds.set(key, accountId);
      }
      const stored = exists.get(tx.source, tx.externalId);
      if (!stored) counts.inserted++;
      else if (
        stored.account_id === accountId &&
        stored.posted_at === tx.postedAt &&
        stored.executed_at === (tx.executedAt ?? null) &&
        stored.amount_cents === tx.amountCents &&
        stored.currency === tx.currency &&
        stored.description_raw === tx.descriptionRaw &&
        stored.description_norm === tx.descriptionNorm &&
        stored.status === tx.status
      )
        counts.unchanged++;
      else counts.updated++;
      stmt.run({
        account_id: accountId,
        source: tx.source,
        external_id: tx.externalId,
        posted_at: tx.postedAt,
        executed_at: tx.executedAt ?? null,
        amount_cents: tx.amountCents,
        currency: tx.currency,
        description_raw: tx.descriptionRaw,
        description_norm: tx.descriptionNorm,
        status: tx.status,
        raw_json: JSON.stringify(tx.raw),
      });
    }
    return counts;
  })(batch);
}

// --- settings -------------------------------------------------------------

export function getSetting(db: Db, key: string): string | undefined {
  return db
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(key)?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare<[string, string]>(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// --- balances -------------------------------------------------------------

/**
 * Observations are immutable: a second import stamping the same `as_of` is the
 * same observation and is dropped, never updated. Returns the number of rows
 * actually inserted.
 */
export function insertBalances(db: Db, balances: readonly BalanceInput[]): number {
  const insert = db.prepare<Record<string, unknown>>(
    `INSERT INTO account_balances
       (account_id, as_of, current_cents, available_cents, currency, raw_json)
     VALUES (@account_id, @as_of, @current_cents, @available_cents, @currency, @raw_json)
     ON CONFLICT (account_id, as_of) DO NOTHING`,
  );
  return db.transaction((rows: readonly BalanceInput[]) => {
    let inserted = 0;
    for (const balance of rows) {
      inserted += insert.run({
        account_id: balance.accountId,
        as_of: balance.asOf,
        current_cents: balance.currentCents,
        available_cents: balance.availableCents ?? null,
        currency: balance.currency,
        raw_json: JSON.stringify(balance.raw),
      }).changes;
    }
    return inserted;
  })(balances);
}

// --- import runs ----------------------------------------------------------

export interface ImportRunRow {
  id: number;
  source: string;
  file_name: string;
  account_id: number | null;
  started_at: string;
  finished_at: string | null;
  rows_inserted: number;
  rows_updated: number;
  /** null on runs recorded before the count existed (migration 010). */
  rows_unchanged: number | null;
  rows_duplicate: number | null;
  rows_skipped: number;
  status: 'running' | 'ok' | 'error';
  error: string | null;
}

export function startImportRun(
  db: Db,
  run: { source: string; fileName: string; accountId?: number | null },
): number {
  const info = db
    .prepare<[string, string, number | null]>(
      "INSERT INTO import_runs (source, file_name, account_id, status) VALUES (?, ?, ?, 'running')",
    )
    .run(run.source, run.fileName, run.accountId ?? null);
  return Number(info.lastInsertRowid);
}

export function finishImportRun(db: Db, id: number, result: ImportRunResult): void {
  db.prepare<Record<string, unknown>>(
    `UPDATE import_runs SET
       finished_at = ${NOW_UTC},
       account_id = coalesce(@account_id, account_id),
       rows_inserted = @rows_inserted,
       rows_updated = @rows_updated,
       rows_unchanged = @rows_unchanged,
       rows_duplicate = @rows_duplicate,
       rows_skipped = @rows_skipped,
       status = @status,
       error = @error
     WHERE id = @id`,
  ).run({
    id,
    account_id: result.accountId ?? null,
    rows_inserted: result.inserted,
    rows_updated: result.updated,
    rows_unchanged: result.unchanged ?? null,
    rows_duplicate: result.duplicates ?? null,
    rows_skipped: result.skipped,
    status: result.status,
    error: result.error ?? null,
  });
}

export function getImportRun(db: Db, id: number): ImportRunRow | undefined {
  return db.prepare<[number], ImportRunRow>('SELECT * FROM import_runs WHERE id = ?').get(id);
}

export function getLastImportRun(db: Db): ImportRunRow | undefined {
  return db.prepare<[], ImportRunRow>('SELECT * FROM import_runs ORDER BY id DESC LIMIT 1').get();
}

export function getLastSuccessfulImportRun(db: Db, accountId?: number): ImportRunRow | undefined {
  return accountId === undefined
    ? db
        .prepare<[], ImportRunRow>(
          "SELECT * FROM import_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
        )
        .get()
    : db
        .prepare<[number], ImportRunRow>(
          "SELECT * FROM import_runs WHERE status = 'ok' AND account_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(accountId);
}

// --- categorisation cache -------------------------------------------------

/** Distinct normalised descriptions with no cached categorisation yet. */
export function getUncategorisedDescriptions(db: Db, limit: number): string[] {
  return db
    .prepare<[number], { description_norm: string }>(
      `SELECT DISTINCT t.description_norm
       FROM transactions t
       LEFT JOIN description_categories c ON c.description_norm = t.description_norm
       WHERE c.description_norm IS NULL
       ORDER BY t.description_norm
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => row.description_norm);
}

export function upsertDescriptionCategories(
  db: Db,
  rows: readonly DescriptionCategoryInput[],
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare<Record<string, unknown>>(
    `INSERT INTO description_categories
       (description_norm, subcategory, confidence, transfer_hint, is_subscription, model)
     VALUES (@description_norm, @subcategory, @confidence, @transfer_hint, @is_subscription, @model)
     ON CONFLICT (description_norm) DO UPDATE SET
       subcategory = excluded.subcategory,
       confidence = excluded.confidence,
       transfer_hint = excluded.transfer_hint,
       is_subscription = excluded.is_subscription,
       model = excluded.model`,
  );
  return db.transaction((batch: readonly DescriptionCategoryInput[]) => {
    for (const row of batch) {
      stmt.run({
        description_norm: row.descriptionNorm,
        subcategory: row.subcategory,
        confidence: row.confidence ?? null,
        transfer_hint: row.transferHint ? 1 : 0,
        is_subscription:
          row.isSubscription === null || row.isSubscription === undefined
            ? null
            : row.isSubscription
              ? 1
              : 0,
        model: row.model ?? null,
      });
    }
    return batch.length;
  })(rows);
}

/**
 * Copies cached machine labels and subscription hints onto transactions, then
 * re-resolves the effective label so a correction keeps winning. Returns the
 * number of rows whose machine fields changed.
 */
export function applyCategoriesToTransactions(db: Db): number {
  return db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE transactions AS t
         SET machine_subcategory = c.subcategory,
             is_subscription = c.is_subscription
         FROM description_categories AS c
         WHERE c.description_norm = t.description_norm
           AND (t.machine_subcategory IS NOT c.subcategory
                OR t.is_subscription IS NOT c.is_subscription)`,
      )
      .run();
    resolveEffectiveCategories(db);
    return info.changes;
  })();
}

// --- category corrections -----------------------------------------
//
// The effective label is materialised into `transactions.subcategory` so every
// reader (tools, evals, status counts) keeps one query shape. Precedence is
// transaction override, then description rule scoped to (source, exact
// normalised description), then machine label. Nothing here touches
// is_subscription or the transfer flags.

export interface TransactionOverrideRow {
  transaction_id: number;
  subcategory: string;
  created_at: string;
  updated_at: string;
}

export interface DescriptionRuleRow {
  id: number;
  source: string;
  description_norm: string;
  subcategory: string;
  created_at: string;
  updated_at: string;
}

/** Narrows the resolver to one row or one rule's scope; absent means every row. */
export type CategoryScope =
  { transactionId: number } | { source: string; descriptionNorm: string } | undefined;

const EFFECTIVE_SUBCATEGORY = `coalesce(
  (SELECT o.subcategory FROM transaction_category_overrides o WHERE o.transaction_id = transactions.id),
  (SELECT r.subcategory FROM description_category_rules r
     WHERE r.source = transactions.source AND r.description_norm = transactions.description_norm),
  machine_subcategory)`;

const EFFECTIVE_ORIGIN = `CASE
  WHEN EXISTS (SELECT 1 FROM transaction_category_overrides o WHERE o.transaction_id = transactions.id)
    THEN 'transaction_override'
  WHEN EXISTS (SELECT 1 FROM description_category_rules r
                WHERE r.source = transactions.source AND r.description_norm = transactions.description_norm)
    THEN 'description_rule'
  WHEN machine_subcategory IS NOT NULL THEN 'llm'
  ELSE NULL END`;

/**
 * Recomputes `subcategory`, `category_source` and `category_origin` from the
 * override, rule and machine label. Returns the rows that changed.
 */
export function resolveEffectiveCategories(db: Db, scope?: CategoryScope): number {
  const where =
    scope === undefined
      ? '1 = 1'
      : 'transactionId' in scope
        ? 'id = @transaction_id'
        : 'source = @source AND description_norm = @description_norm';
  const params =
    scope === undefined
      ? {}
      : 'transactionId' in scope
        ? { transaction_id: scope.transactionId }
        : { source: scope.source, description_norm: scope.descriptionNorm };
  return db
    .prepare<Record<string, unknown>>(
      `UPDATE transactions
       SET subcategory = ${EFFECTIVE_SUBCATEGORY},
           category_origin = ${EFFECTIVE_ORIGIN},
           category_source = CASE
             WHEN (${EFFECTIVE_ORIGIN}) IS NULL THEN NULL
             WHEN (${EFFECTIVE_ORIGIN}) = 'llm' THEN 'llm'
             ELSE 'manual' END
       WHERE ${where}
         AND (subcategory IS NOT ${EFFECTIVE_SUBCATEGORY}
              OR category_origin IS NOT ${EFFECTIVE_ORIGIN})`,
    )
    .run(params).changes;
}

export function getTransactionById(db: Db, id: number): TransactionRow | undefined {
  return db.prepare<[number], TransactionRow>('SELECT * FROM transactions WHERE id = ?').get(id);
}

export function getTransactionOverride(
  db: Db,
  transactionId: number,
): TransactionOverrideRow | undefined {
  return db
    .prepare<[number], TransactionOverrideRow>(
      'SELECT * FROM transaction_category_overrides WHERE transaction_id = ?',
    )
    .get(transactionId);
}

/** Caller validates the leaf and the transaction; this only stores and re-resolves. */
export function upsertTransactionOverride(db: Db, transactionId: number, subcategory: string) {
  db.transaction(() => {
    db.prepare<[number, string]>(
      `INSERT INTO transaction_category_overrides (transaction_id, subcategory) VALUES (?, ?)
       ON CONFLICT (transaction_id) DO UPDATE SET
         subcategory = excluded.subcategory,
         updated_at = ${NOW_UTC}`,
    ).run(transactionId, subcategory);
    resolveEffectiveCategories(db, { transactionId });
  })();
}

/** Returns true when an override existed. */
export function deleteTransactionOverride(db: Db, transactionId: number): boolean {
  return db.transaction(() => {
    const removed =
      db
        .prepare<[number]>('DELETE FROM transaction_category_overrides WHERE transaction_id = ?')
        .run(transactionId).changes > 0;
    if (removed) resolveEffectiveCategories(db, { transactionId });
    return removed;
  })();
}

export function getDescriptionRule(
  db: Db,
  source: string,
  descriptionNorm: string,
): DescriptionRuleRow | undefined {
  return db
    .prepare<[string, string], DescriptionRuleRow>(
      'SELECT * FROM description_category_rules WHERE source = ? AND description_norm = ?',
    )
    .get(source, descriptionNorm);
}

export function listDescriptionRules(db: Db): DescriptionRuleRow[] {
  return db
    .prepare<[], DescriptionRuleRow>(
      'SELECT * FROM description_category_rules ORDER BY source, description_norm',
    )
    .all();
}

export function listTransactionOverrides(db: Db): TransactionOverrideRow[] {
  return db
    .prepare<[], TransactionOverrideRow>(
      'SELECT * FROM transaction_category_overrides ORDER BY transaction_id',
    )
    .all();
}

/** Stored transactions a rule for this scope covers, whatever their current origin. */
export function countRuleMatches(db: Db, source: string, descriptionNorm: string): number {
  return db
    .prepare<[string, string], { n: number }>(
      'SELECT count(*) n FROM transactions WHERE source = ? AND description_norm = ?',
    )
    .get(source, descriptionNorm)!.n;
}

export function upsertDescriptionRule(
  db: Db,
  source: string,
  descriptionNorm: string,
  subcategory: string,
): DescriptionRuleRow {
  return db.transaction(() => {
    db.prepare<[string, string, string]>(
      `INSERT INTO description_category_rules (source, description_norm, subcategory)
       VALUES (?, ?, ?)
       ON CONFLICT (source, description_norm) DO UPDATE SET
         subcategory = excluded.subcategory,
         updated_at = ${NOW_UTC}`,
    ).run(source, descriptionNorm, subcategory);
    resolveEffectiveCategories(db, { source, descriptionNorm });
    return getDescriptionRule(db, source, descriptionNorm)!;
  })();
}

/** Returns true when a rule existed. */
export function deleteDescriptionRule(db: Db, source: string, descriptionNorm: string): boolean {
  return db.transaction(() => {
    const removed =
      db
        .prepare<[string, string]>(
          'DELETE FROM description_category_rules WHERE source = ? AND description_norm = ?',
        )
        .run(source, descriptionNorm).changes > 0;
    if (removed) resolveEffectiveCategories(db, { source, descriptionNorm });
    return removed;
  })();
}

// --- saved web conversations -----------------------------------------------
export interface ConversationRow {
  id: string;
  title: string;
  backend_spec: string;
  created_at: string;
  updated_at: string;
}
export interface ConversationMessageRow {
  id: number;
  conversation_id: string;
  request_id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'pending' | 'completed' | 'failed' | 'interrupted';
  termination_reason: string | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
}
export interface ConversationCursor {
  updatedAt: string;
  id: string;
}
export function listConversations(db: Db, limit = 50, before?: ConversationCursor) {
  const rows = db
    .prepare<unknown[], ConversationRow>(
      `SELECT * FROM conversations
    ${before ? 'WHERE (updated_at, id) < (?, ?)' : ''}
    ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(...(before ? [before.updatedAt, before.id] : []), limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    conversations: items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at, id: last.id })).toString(
            'base64url',
          )
        : null,
  };
}
export function loadConversation(db: Db, id: string) {
  const conversation = db
    .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
    .get(id);
  if (!conversation) return undefined;
  const messages = db
    .prepare<[string], ConversationMessageRow>(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id',
    )
    .all(id);
  return { conversation, messages };
}
export function findChatRequest(db: Db, requestId: string) {
  const assistant = db
    .prepare<[string], ConversationMessageRow>(
      "SELECT * FROM conversation_messages WHERE request_id = ? AND role = 'assistant'",
    )
    .get(requestId);
  if (!assistant) return undefined;
  const user = db
    .prepare<[string, string], { id: number }>(
      "SELECT id FROM conversation_messages WHERE conversation_id = ? AND request_id = ? AND role = 'user'",
    )
    .get(assistant.conversation_id, requestId)!;
  return {
    conversationId: assistant.conversation_id,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
  };
}
export function startChatExchange(
  db: Db,
  input: {
    conversationId: string;
    requestId: string;
    text: string;
    backend: string;
    create: boolean;
  },
) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    if (input.create)
      db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?)').run(
        input.conversationId,
        input.text.trim().replace(/\s+/g, ' ').slice(0, 80),
        input.backend,
        now,
        now,
      );
    const insert = db.prepare(
      'INSERT INTO conversation_messages (conversation_id,request_id,role,text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    );
    const user = insert.run(
      input.conversationId,
      input.requestId,
      'user',
      input.text,
      'completed',
      now,
      now,
    );
    const assistant = insert.run(
      input.conversationId,
      input.requestId,
      'assistant',
      '',
      'pending',
      now,
      now,
    );
    db.prepare('UPDATE conversations SET updated_at = ?, backend_spec = ? WHERE id = ?').run(
      now,
      input.backend,
      input.conversationId,
    );
    return {
      conversationId: input.conversationId,
      userMessageId: Number(user.lastInsertRowid),
      assistantMessageId: Number(assistant.lastInsertRowid),
    };
  })();
}
export function checkpointChatMessage(db: Db, id: number, text: string) {
  db.prepare(
    "UPDATE conversation_messages SET text = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
  ).run(text, new Date().toISOString(), id);
}
export function finalizeChatMessage(
  db: Db,
  input: {
    id: number;
    text: string;
    status: 'completed' | 'failed' | 'interrupted';
    reason: string;
    error: string | null;
    backend: string;
  },
) {
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE conversation_messages SET text = ?, status = ?, termination_reason = ?, error_text = ?, updated_at = ? WHERE id = ?',
    ).run(input.text, input.status, input.reason, input.error, now, input.id);
    db.prepare(
      'UPDATE conversations SET updated_at = ?, backend_spec = ? WHERE id = (SELECT conversation_id FROM conversation_messages WHERE id = ?)',
    ).run(now, input.backend, input.id);
  })();
}
export function deleteConversation(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
}
/** Deletes every saved conversation (messages cascade); the count removed. */
export function deleteAllConversations(db: Db): number {
  return db.prepare('DELETE FROM conversations').run().changes;
}
export function recoverPendingChats(db: Db): number {
  return db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE conversations SET updated_at = ? WHERE id IN (SELECT conversation_id FROM conversation_messages WHERE status = 'pending')",
    ).run(now);
    return db
      .prepare(
        "UPDATE conversation_messages SET status = 'interrupted', termination_reason = 'server_restart', error_text = 'Interrupted by a server restart. You can ask again.', updated_at = ? WHERE status = 'pending'",
      )
      .run(now).changes;
  })();
}
