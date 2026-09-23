import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb, openMemoryDb, type Db } from '../../src/db/client.js';
import * as repo from '../../src/db/repo.js';
let db: Db;
beforeEach(() => {
  db = openMemoryDb();
});
afterEach(() => db.close());
function start(conversationId = randomUUID(), requestId = randomUUID(), create = true) {
  return repo.startChatExchange(db, {
    conversationId,
    requestId,
    create,
    text: '  My   first\nquestion  ',
    backend: 'local/test',
  });
}
it('creates paired ordered messages and rolls back all writes on a duplicate request', () => {
  const id = randomUUID(),
    request = randomUUID();
  const exchange = start(id, request);
  const saved = repo.loadConversation(db, id)!;
  expect(saved.conversation.title).toBe('My first question');
  expect(saved.messages.map((m) => [m.role, m.status])).toEqual([
    ['user', 'completed'],
    ['assistant', 'pending'],
  ]);
  expect(repo.findChatRequest(db, request)).toEqual(exchange);
  expect(() => start(randomUUID(), request)).toThrow();
  expect(repo.listConversations(db).conversations).toHaveLength(1);
  expect(saved.messages.map((m) => m.id)).toEqual([
    exchange.userMessageId,
    exchange.assistantMessageId,
  ]);
  expect(() => start(randomUUID(), randomUUID(), false)).toThrow();
  expect(repo.listConversations(db).conversations).toHaveLength(1);
});
it('paginates with stable ties, checkpoints without changing activity, finalizes atomically and cascades deletion', () => {
  const first = start(),
    second = start(),
    third = start();
  db.prepare('UPDATE conversations SET updated_at = ?').run('2026-01-01T00:00:00.000Z');
  const page = repo.listConversations(db, 2);
  const cursor = JSON.parse(
    Buffer.from(page.nextCursor!, 'base64url').toString(),
  ) as repo.ConversationCursor;
  const next = repo.listConversations(db, 2, cursor);
  expect([...page.conversations, ...next.conversations].map((c) => c.id)).toEqual(
    [first, second, third]
      .map((c) => c.conversationId)
      .sort()
      .reverse(),
  );
  expect(next.nextCursor).toBeNull();
  repo.checkpointChatMessage(db, first.assistantMessageId, 'partial');
  expect(repo.loadConversation(db, first.conversationId)!.conversation.updated_at).toBe(
    '2026-01-01T00:00:00.000Z',
  );
  repo.finalizeChatMessage(db, {
    id: first.assistantMessageId,
    text: 'final',
    status: 'completed',
    reason: 'answered',
    error: null,
    backend: 'local/other',
  });
  expect(repo.listConversations(db).conversations[0]?.id).toBe(first.conversationId);
  expect(repo.loadConversation(db, first.conversationId)!.conversation.backend_spec).toBe(
    'local/other',
  );
  expect(repo.deleteConversation(db, first.conversationId)).toBe(true);
  expect(
    repo.findChatRequest(
      db,
      repo.loadConversation(db, second.conversationId)!.messages[0]!.request_id,
    ),
  ).toBeDefined();
  expect(
    db
      .prepare('SELECT * FROM conversation_messages WHERE conversation_id = ?')
      .all(first.conversationId),
  ).toEqual([]);
});
it('recovers pending responses while preserving checkpoint text', () => {
  const exchange = start();
  repo.checkpointChatMessage(db, exchange.assistantMessageId, 'partial');
  expect(repo.recoverPendingChats(db)).toBe(1);
  expect(repo.recoverPendingChats(db)).toBe(0);
  expect(repo.loadConversation(db, exchange.conversationId)!.messages[1]).toMatchObject({
    text: 'partial',
    status: 'interrupted',
    termination_reason: 'server_restart',
  });
});
it('upgrades a seeded 001 database and preserves chats and finance rows across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerchat-history-'));
  const path = join(dir, 'test.sqlite');
  try {
    const old = new Database(path);
    old.exec(
      readFileSync(new URL('../../src/db/migrations/001_init.sql', import.meta.url), 'utf8'),
    );
    old.exec(
      "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT); INSERT INTO schema_migrations VALUES ('001_init.sql', '2026-01-01');",
    );
    repo.upsertAccount(old, {
      source: 'test',
      externalId: '1',
      name: 'Preserved',
      currency: 'AUD',
      raw: {},
    });
    repo.upsertTransactions(old, [
      {
        source: 'test',
        externalId: 'tx1',
        accountExternalId: '1',
        postedAt: '2026-01-01',
        amountCents: -1200,
        currency: 'AUD',
        descriptionRaw: 'Preserved transaction',
        descriptionNorm: 'preserved transaction',
        status: 'posted',
        raw: {},
      },
    ]);
    old.close();
    let upgraded = openDb(path);
    const id = randomUUID();
    repo.startChatExchange(upgraded, {
      conversationId: id,
      requestId: randomUUID(),
      text: 'Persist me',
      backend: 'local/test',
      create: true,
    });
    upgraded.close();
    upgraded = openDb(path);
    expect(upgraded.prepare('SELECT name FROM accounts').get()).toEqual({ name: 'Preserved' });
    expect(upgraded.prepare('SELECT amount_cents FROM transactions').get()).toEqual({
      amount_cents: -1200,
    });
    expect(repo.loadConversation(upgraded, id)?.messages).toHaveLength(2);
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rolls back finalization if updating conversation metadata fails', () => {
  const exchange = start();
  db.exec(
    "CREATE TRIGGER fail_activity BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'failure'); END",
  );
  expect(() =>
    repo.finalizeChatMessage(db, {
      id: exchange.assistantMessageId,
      text: 'answer',
      status: 'completed',
      reason: 'answered',
      error: null,
      backend: 'local/other',
    }),
  ).toThrow();
  expect(repo.loadConversation(db, exchange.conversationId)!.messages[1]).toMatchObject({
    status: 'pending',
    text: '',
  });
});
