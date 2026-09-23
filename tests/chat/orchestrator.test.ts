import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { search } from '../../src/tools/registry.js';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import type { LlmBackend } from '../../src/llm/backend.js';
import { getCapabilities } from '../../src/llm/capabilities.js';
import type {
  ChatMessage,
  CompleteRequest,
  ToolCall,
  ToolResult,
  Turn,
} from '../../src/llm/types.js';
import {
  runConversation,
  unevidencedFigures,
  type ChatEvent,
} from '../../src/chat/orchestrator.js';
let db: Db;
beforeEach(() => (db = openMemoryDb()));
afterEach(() => db.close());
const call = (name = 'search_transactions', rawInput: unknown = {}): ToolCall => ({
  id: name,
  name,
  rawInput,
});
const turn = (calls: ToolCall[] = []): Turn => ({
  text: calls.length ? '' : 'No matching transactions.',
  toolCalls: calls,
  stopReason: calls.length ? 'tool_calls' : 'end',
  usage: { inputTokens: 10, outputTokens: 5 },
  latencyMs: 1,
});
function backend(
  complete: (req: CompleteRequest) => Promise<Turn>,
  maxTokens?: number,
): LlmBackend {
  return {
    label: 'fake',
    capabilities: getCapabilities(),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    complete,
  };
}
it('uses the backend output cap, defaulting to 8192', async () => {
  for (const [configured, expected] of [
    [undefined, 8192],
    [1024, 1024],
  ] as const) {
    const complete = vi.fn().mockResolvedValue(turn());
    await runConversation({
      db,
      backend: backend(complete, configured),
      messages: [{ role: 'user', text: 'Hi' }],
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: expected }));
  }
});
for (const bad of [call('missing'), call('search_transactions', { limit: 0 })])
  it(`recovers from ${bad.name} error`, async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(turn([bad]))
      .mockResolvedValueOnce(turn());
    const result = await runConversation({
      db,
      backend: backend(complete),
      messages: [{ role: 'user', text: 'Hi' }],
    });
    expect(result.failed).toBe(false);
    expect(result.trace.turns[0]!.validationErrors).toHaveLength(1);
    expect(result.trace.turns).toHaveLength(2);
    expect(result.trace.turns[1]!.usage.inputTokens).toBe(10);
    expect(result.trace.turns[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });
it('batches parallel results and retains tool array identity', async () => {
  const calls = [call(), call('get_recurring_charges')];
  let invocation = 0;
  const events: ChatEvent[] = [];
  const result = await runConversation({
    db,
    messages: [],
    onEvent: (e) => events.push(e),
    backend: backend(async (req) => {
      await Promise.resolve();
      if (invocation++ === 0) return turn(calls);
      expect(req.messages[0]).toMatchObject({ role: 'assistant' });
      const assistant = req.messages[0];
      if (assistant?.role === 'assistant') expect(assistant.toolCalls).toBe(calls);
      expect(req.messages[1]).toMatchObject({
        role: 'tool',
        results: [{ callId: 'search_transactions' }, { callId: 'get_recurring_charges' }],
      });
      return turn();
    }),
  });
  expect(result.failed).toBe(false);
  expect(events.map((e) => e.type)).toEqual([
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'text',
    'done',
  ]);
});
it('stops at eight iterations of distinct calls', async () => {
  let n = 0;
  const complete = vi.fn(() =>
    Promise.resolve(turn([call('search_transactions', { limit: ++n })])),
  );
  const result = await runConversation({ db, messages: [], backend: backend(complete) });
  expect(complete).toHaveBeenCalledTimes(8);
  expect(result.text).toContain('eight-turn');
  expect(result.failed).toBe(true);
});
it('stops after three distinct all-error batches', async () => {
  let n = 0;
  const complete = vi.fn(() => Promise.resolve(turn([call('missing', { n: ++n })])));
  const result = await runConversation({ db, messages: [], backend: backend(complete) });
  expect(complete).toHaveBeenCalledTimes(3);
  expect(result.text).toContain('three attempts');
});
it('does not release streamed text before validation and stops on cancellation', async () => {
  const controller = new AbortController();
  const events: ChatEvent[] = [];
  const complete = vi.fn(async (req: CompleteRequest) => {
    await Promise.resolve();
    expect(req.signal).toBe(controller.signal);
    req.onText?.('Hello');
    controller.abort();
    return turn([call()]);
  });
  const result = await runConversation({
    db,
    messages: [],
    backend: backend(complete),
    signal: controller.signal,
    onEvent: (e) => events.push(e),
  });
  expect(result.failed).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(events.map((e) => e.type)).toEqual(['error', 'done']);
});
it('sanitises backend exceptions', async () => {
  const result = await runConversation({
    db,
    messages: [],
    backend: backend(async () => {
      await Promise.reject(new Error('secret api key'));
      return turn();
    }),
  });
  expect(result.text).not.toContain('secret');
  expect(result.failed).toBe(true);
});

it('renders a spending comparison from the tool result without asking the model for figures', async () => {
  const { upsertAccount, upsertTransactions } = await import('../../src/db/repo.js');
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'Test', currency: 'AUD', raw: {} });
  upsertTransactions(
    db,
    ['2026-07-15', '2026-08-15'].map((date, i) => ({
      source: 'test',
      externalId: String(i),
      accountExternalId: 'a',
      postedAt: `${date}T00:00:00Z`,
      amountCents: i ? -15000 : -10000,
      currency: 'AUD',
      descriptionRaw: 'Woolworths',
      descriptionNorm: 'woolworths',
      status: 'posted',
      raw: {},
    })),
  );
  const complete = vi.fn(async () => {
    await Promise.resolve();
    return turn([
      call('get_spending_summary', {
        query: 'woolworths',
        period: 'last_month',
        group_by: 'merchant',
        compare_from: '2026-07-01',
        compare_to: '2026-07-31',
      }),
    ]);
  });
  const result = await runConversation({
    db,
    now: new Date('2026-09-10T12:00:00Z'),
    messages: [{ role: 'user', text: 'Woolworths spending last month compared with July?' }],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('AUD 150.00');
  expect(result.text).toContain('AUD 100.00');
  expect(result.text).toContain('AUD 50.00 more');
  expect(result.text).toContain('1 Aug 2026 to 31 Aug 2026');
  expect(result.text).toContain('1 July 2026 to 31 July 2026');
  expect(result.text).not.toContain('50%');
});

it('does not render a named merchant comparison until the tool includes its query filter', async () => {
  const { upsertAccount, upsertTransactions } = await import('../../src/db/repo.js');
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'Test', currency: 'AUD', raw: {} });
  upsertTransactions(
    db,
    [
      ['2026-07-15', 'woolworths', -10000],
      ['2026-07-16', 'cafe', -5000],
      ['2026-08-15', 'woolworths', -15000],
      ['2026-08-16', 'cafe', -7500],
    ].map(([date, description, cents], index) => ({
      source: 'test',
      externalId: String(index),
      accountExternalId: 'a',
      postedAt: `${String(date)}T00:00:00Z`,
      amountCents: Number(cents),
      currency: 'AUD',
      descriptionRaw: String(description),
      descriptionNorm: String(description),
      status: 'posted' as const,
      raw: {},
    })),
  );
  let turnIndex = 0;
  const complete = vi.fn(async () => {
    await Promise.resolve();
    return turn([
      call('get_spending_summary', {
        group_by: 'merchant',
        from: '2026-08-01',
        to: '2026-08-31',
        compare_from: '2026-07-01',
        compare_to: '2026-07-31',
        ...(turnIndex++ === 0 ? {} : { query: 'woolworths' }),
      }),
    ]);
  });
  const result = await runConversation({
    db,
    messages: [
      { role: 'user', text: 'How did my Woolworths spending change between July and August 2026?' },
    ],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(result.text).toContain('AUD 100.00');
  expect(result.text).toContain('AUD 150.00');
  expect(result.text).toContain('AUD 50.00 more');
  expect(result.text).not.toContain('AUD 225.00');
});

it('lets the model finish an unsupported multi-part question after a comparison result', async () => {
  const complete = vi
    .fn()
    .mockResolvedValueOnce(
      turn([
        call('get_spending_summary', {
          category: 'food_drink',
          group_by: 'merchant',
          from: '2026-08-01',
          to: '2026-08-31',
          compare_from: '2026-07-01',
          compare_to: '2026-07-31',
        }),
      ]),
    )
    .mockResolvedValueOnce({
      ...turn(),
      text: 'No posted food spending or transactions were found.',
    });
  const result = await runConversation({
    db,
    messages: [
      {
        role: 'user',
        text: 'Compare food spending in July and August 2026, and list my latest transactions.',
      },
    ],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(result.text).toContain('transactions');
});

it('answers a comparison and ranked merchant descriptions from one grouped tool result', async () => {
  const { upsertAccount, upsertTransactions } = await import('../../src/db/repo.js');
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'Test', currency: 'AUD', raw: {} });
  upsertTransactions(
    db,
    [
      ['2026-07-15', 'woolworths', -90000],
      ['2026-07-16', 'cafe', -32632],
      ['2026-08-15', 'woolworths', -150000],
      ['2026-08-16', 'cafe', -36940],
    ].map(([date, description, cents], index) => ({
      source: 'test',
      externalId: String(index),
      accountExternalId: 'a',
      postedAt: `${String(date)}T00:00:00Z`,
      amountCents: Number(cents),
      currency: 'AUD',
      descriptionRaw: String(description),
      descriptionNorm: String(description),
      status: 'posted' as const,
      raw: {},
    })),
  );
  const complete = vi.fn().mockResolvedValue(
    turn([
      call('get_spending_summary', {
        group_by: 'merchant',
        from: '2026-08-01',
        to: '2026-08-31',
        compare_from: '2026-07-01',
        compare_to: '2026-07-31',
      }),
    ]),
  );
  const result = await runConversation({
    db,
    messages: [
      { role: 'user', text: 'Compare spending in July and August 2026, and list top merchants.' },
    ],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('AUD 643.08 more');
  expect(result.text).toContain('woolworths: **AUD 1,500.00**');
  expect(result.text).toContain('cafe: **AUD 369.40**');
});

it('withholds free-form spending comparison figures when no comparison result was supplied', async () => {
  const complete = vi.fn().mockResolvedValue({
    ...turn(),
    text: 'August was $3,095.72 and July was $1,226.32, so the increase was $1,869.40.',
  });
  const events: ChatEvent[] = [];
  const result = await runConversation({
    db,
    messages: [{ role: 'user', text: 'How much more did I spend in August than July?' }],
    backend: backend(complete),
    onEvent: (event) => events.push(event),
  });
  expect(result.reason).toBe('unverified_answer');
  expect(result.failed).toBe(true);
  expect(result.text).not.toContain('$');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(events.filter((event) => event.type === 'text')).toEqual([]);
  expect(events.filter((event) => event.type === 'retry')).toEqual([
    { type: 'retry', reason: 'comparison_needs_tool' },
  ]);
});

it.each([
  ['What actually came in and went out last month?', 'get_cash_flow', { period: 'last_month' }],
  ['What is my bank balance?', 'list_accounts', {}],
])('executes the scripted tool route for %s', async (question, name, args) => {
  let invocation = 0;
  const result = await runConversation({
    db,
    messages: [{ role: 'user', text: question }],
    backend: backend(async (req) => {
      await Promise.resolve();
      expect(req.system).toContain('Use get_cash_flow for actual incoming credits');
      if (invocation++ === 0) return turn([call(name, args)]);
      const message = req.messages.at(-1);
      expect(message).toMatchObject({ role: 'tool', results: [{ callId: name, isError: false }] });
      return turn();
    }),
  });
  expect(result.failed).toBe(false);
});

it('renders a requested account balance directly from list_accounts', async () => {
  const { upsertAccount, insertBalances } = await import('../../src/db/repo.js');
  const id = upsertAccount(db, {
    source: 'test',
    externalId: 'a',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  insertBalances(db, [
    {
      accountId: id,
      asOf: '2026-09-11T05:00:00.000Z',
      currentCents: 74777,
      currency: 'AUD',
      raw: {},
    },
  ]);
  const complete = vi.fn().mockResolvedValue(turn([call('list_accounts', {})]));
  const result = await runConversation({
    db,
    messages: [{ role: 'user', text: 'What is my Everyday card balance?' }],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('Everyday: current **AUD 747.77** as of 11 Sept 2026');
});

it('rejects a wrong cash-flow period before rendering labeled metrics', async () => {
  const { upsertAccount, upsertTransactions } = await import('../../src/db/repo.js');
  upsertAccount(db, {
    source: 'test',
    externalId: 'a',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertTransactions(
    db,
    [
      ['2026-08-10', 20000],
      ['2026-08-12', -10000],
    ].map(([day, cents], index) => ({
      source: 'test',
      externalId: String(index),
      accountExternalId: 'a',
      postedAt: `${String(day)}T00:00:00Z`,
      amountCents: Number(cents),
      currency: 'AUD',
      descriptionRaw: String(index),
      descriptionNorm: String(index),
      status: 'posted' as const,
      raw: {},
    })),
  );
  let attempt = 0;
  const complete = vi.fn(() =>
    Promise.resolve(
      turn([
        call('get_cash_flow', {
          period: attempt++ === 0 ? 'this_month' : 'last_month',
        }),
      ]),
    ),
  );
  const result = await runConversation({
    db,
    now: new Date('2026-09-23T12:00:00Z'),
    messages: [{ role: 'user', text: 'What actually came in and went out last month?' }],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(result.text).toContain('incoming credits: **AUD 200.00**');
  expect(result.text).toContain('outgoing debits: **AUD 100.00**');
  expect(result.text).toContain('net flow: **AUD 100.00**');
  expect(result.text).toContain('1 Aug 2026 to 31 Aug 2026');
});

it('withholds a direct balance claim when the model skips list_accounts', async () => {
  const events: ChatEvent[] = [];
  const complete = vi.fn().mockResolvedValue({
    ...turn(),
    text: 'The balance in Everyday is AUD 747.77.',
  });
  const result = await runConversation({
    db,
    messages: [{ role: 'user', text: 'What is my Everyday balance?' }],
    backend: backend(complete),
    onEvent: (event) => events.push(event),
  });
  expect(result.failed).toBe(true);
  expect(result.reason).toBe('unverified_answer');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(events.filter((event) => event.type === 'text')).toEqual([]);
  expect(events.filter((event) => event.type === 'retry')).toEqual([
    { type: 'retry', reason: 'direct_answer_needs_tool' },
  ]);
});

it('does not present missing imported coverage as zero spending', async () => {
  const complete = vi.fn().mockResolvedValue(
    turn([
      call('get_spending_summary', {
        group_by: 'category',
        from: '2026-08-01',
        to: '2026-08-31',
        compare_from: '2026-07-01',
        compare_to: '2026-07-31',
      }),
    ]),
  );
  const result = await runConversation({
    db,
    messages: [{ role: 'user', text: 'Compare spending in July and August 2026.' }],
    backend: backend(complete),
  });
  expect(result.failed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('No imported transactions overlap');
  expect(result.text).toContain('comparison for these periods is unavailable');
  expect(result.text).not.toContain('AUD 0.00');
});

it('passes a search cursor through a scripted second-page conversation', async () => {
  const { upsertAccount, upsertTransactions } = await import('../../src/db/repo.js');
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'Test', currency: 'AUD', raw: {} });
  upsertTransactions(
    db,
    [1, 2, 3].map((id) => ({
      source: 'test',
      externalId: String(id),
      accountExternalId: 'a',
      postedAt: '2026-01-01T00:00:00Z',
      amountCents: id * 100,
      currency: 'AUD',
      descriptionRaw: 'payment',
      descriptionNorm: 'payment',
      status: 'posted',
      raw: {},
    })),
  );
  let invocation = 0;
  const args = { direction: 'credit', sort: 'largest', limit: 1 };
  const result = await runConversation({
    db,
    messages: [
      {
        role: 'user',
        text: 'Show the largest incoming payment, then the next page and the total for all matches.',
      },
    ],
    backend: backend(async (req) => {
      await Promise.resolve();
      if (invocation++ === 0) return turn([call('search_transactions', args)]);
      const message = req.messages.at(-1);
      if (message?.role !== 'tool') throw new Error('Missing search result');
      const data = JSON.parse(message.results[0]!.content) as ReturnType<typeof search>;
      expect(data.matched_rows_totals[0]!.credit_total.cents).toBe(600);
      if (invocation === 2) {
        expect(data.returned_rows_totals[0]!.credit_total.cents).toBe(300);
        return turn([call('search_transactions', { ...args, cursor: data.next_cursor })]);
      }
      expect(data.rows[0]!.id).toBe(2);
      expect(data.returned_rows_totals[0]!.credit_total.cents).toBe(200);
      return turn();
    }),
  });
  expect(result.failed).toBe(false);
  expect(invocation).toBe(3);
});

// exact repeated calls within one request.
// Snapshots the tool results each request was sent, since the orchestrator
// mutates one messages array in place.
const scripted = (turns: Turn[]) => {
  let i = 0;
  const seen: ToolResult[][] = [];
  const complete = vi.fn((req: CompleteRequest) => {
    const message = req.messages.at(-1);
    seen.push(message?.role === 'tool' ? [...message.results] : []);
    return Promise.resolve(turns[Math.min(i++, turns.length - 1)]!);
  });
  return Object.assign(complete, { seen });
};
const id = (name: string, n: number, rawInput: unknown): ToolCall => ({
  id: `${name}-${String(n)}`,
  name,
  rawInput,
});
it('signatures ignore key order and call id but not values or cursors', async () => {
  const { toolCallSignature } = await import('../../src/chat/orchestrator.js');
  expect(toolCallSignature('search_transactions', { a: 1, b: { c: [1, 2], d: 'x' } })).toBe(
    toolCallSignature('search_transactions', { b: { d: 'x', c: [1, 2] }, a: 1 }),
  );
  expect(toolCallSignature('search_transactions', { cursor: 'a' })).not.toBe(
    toolCallSignature('search_transactions', { cursor: 'b' }),
  );
  expect(toolCallSignature('search_transactions', {})).not.toBe(
    toolCallSignature('get_cash_flow', {}),
  );
  expect(toolCallSignature('x', { a: [1, 2] })).not.toBe(toolCallSignature('x', { a: [2, 1] }));
  for (const malformed of [undefined, null, 'text', 42, NaN, [1, { z: 1, y: 2 }]])
    expect(toolCallSignature('x', malformed)).toBe(toolCallSignature('x', malformed));
});
it('answers a repeated valid search with a no-progress response, then stops on the third repeat', async () => {
  const args = { query: 'rent', limit: 20 };
  const events: ChatEvent[] = [];
  const complete = scripted([
    turn([id('search_transactions', 1, args)]),
    turn([id('search_transactions', 2, { limit: 20, query: 'rent' })]),
    turn([id('search_transactions', 3, args)]),
    turn(),
  ]);
  const result = await runConversation({
    db,
    messages: [{ role: 'user', text: 'rent?' }],
    backend: backend(complete),
    onEvent: (e) => events.push(e),
  });
  expect(result.failed).toBe(true);
  expect(result.reason).toBe('repeated_call');
  expect(result.text).toContain('three times');
  expect(complete).toHaveBeenCalledTimes(3);
  const feedback = JSON.parse(complete.seen[2]![0]!.content) as Record<string, unknown>;
  expect(complete.seen[2]![0]!.callId).toBe('search_transactions-2');
  expect(feedback).toMatchObject({
    error: 'no_progress',
    earlier_call_id: 'search_transactions-1',
    earlier_outcome: 'result',
  });
  expect(String(feedback.earlier_content)).toContain('total_matched_count');
  expect(result.trace.turns.map((t) => t.repeatedCalls)).toEqual([
    [],
    [
      {
        callId: 'search_transactions-2',
        name: 'search_transactions',
        occurrence: 2,
        action: 'no_progress_response',
      },
    ],
    [
      {
        callId: 'search_transactions-3',
        name: 'search_transactions',
        occurrence: 3,
        action: 'terminated',
      },
    ],
  ]);
  // Every call id has exactly one result and the transcript ends with those results.
  const toolMessages = result.messages.filter((m) => m.role === 'tool');
  expect(
    toolMessages.map((m) => (m.role === 'tool' ? m.results.map((r) => r.callId) : [])),
  ).toEqual([['search_transactions-1'], ['search_transactions-2'], ['search_transactions-3']]);
  expect(result.messages.at(-1)!.role).toBe('tool');
  expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3);
});
it('references the earlier validation error for a repeated invalid period and stops before the error cap', async () => {
  const bad = { period: 'yesterday', group_by: 'category' };
  const complete = scripted([
    turn([id('get_spending_summary', 1, bad)]),
    turn([id('get_spending_summary', 2, bad)]),
    turn([id('get_spending_summary', 3, bad)]),
    turn([id('get_spending_summary', 4, bad)]),
  ]);
  const result = await runConversation({ db, messages: [], backend: backend(complete) });
  expect(result.reason).toBe('repeated_call');
  expect(complete).toHaveBeenCalledTimes(3);
  const feedback = JSON.parse(complete.seen[2]![0]!.content) as Record<string, unknown>;
  expect(feedback).toMatchObject({ earlier_outcome: 'validation_error' });
  expect(String(feedback.instruction)).toContain('Correct the arguments');
});
it('lets a model that changes its arguments after feedback finish, treating a new cursor as progress', async () => {
  const complete = scripted([
    turn([id('search_transactions', 1, { limit: 1 })]),
    turn([id('search_transactions', 2, { limit: 1 })]),
    turn([id('search_transactions', 3, { limit: 1, cursor: 'different' })]),
    turn([id('search_transactions', 4, { limit: 2 })]),
    turn(),
  ]);
  const result = await runConversation({ db, messages: [], backend: backend(complete) });
  expect(result.failed).toBe(false);
  expect(result.reason).toBe('answered');
  expect(complete).toHaveBeenCalledTimes(5);
  expect(result.trace.turns.flatMap((t) => t.repeatedCalls ?? [])).toHaveLength(1);
});
it('handles repeats inside mixed batches: a fresh call in the batch is progress, a batch of repeats is not', async () => {
  const complete = scripted([
    turn([id('list_accounts', 1, {}), id('get_recurring_charges', 1, {})]),
    turn([id('list_accounts', 2, {}), id('get_upcoming_payments', 1, { days: 7 })]),
    turn([id('list_accounts', 3, {}), id('get_cash_flow', 1, { period: 'this_month' })]),
    turn([id('list_accounts', 4, {}), id('get_recurring_charges', 2, {})]),
    turn(),
  ]);
  const result = await runConversation({ db, messages: [], backend: backend(complete) });
  expect(result.reason).toBe('repeated_call');
  expect(complete).toHaveBeenCalledTimes(4);
  expect(complete.seen[2]!.map((r) => [r.callId, r.isError])).toEqual([
    ['list_accounts-2', true],
    ['get_upcoming_payments-1', false],
  ]);
  expect(complete.seen[3]!.map((r) => [r.callId, r.isError])).toEqual([
    ['list_accounts-3', true],
    ['get_cash_flow-1', false],
  ]);
  expect(result.trace.turns[2]!.repeatedCalls).toEqual([
    {
      callId: 'list_accounts-3',
      name: 'list_accounts',
      occurrence: 3,
      action: 'no_progress_response',
    },
  ]);
  const last = result.messages.at(-1);
  expect(last?.role === 'tool' && last.results.map((r) => [r.callId, r.isError])).toEqual([
    ['list_accounts-4', true],
    ['get_recurring_charges-2', true],
  ]);
  expect(result.trace.turns[3]!.repeatedCalls!.map((r) => [r.occurrence, r.action])).toEqual([
    [4, 'terminated'],
    [2, 'no_progress_response'],
  ]);
});
it('two identical calls in one batch count as a repeat but not as termination', async () => {
  const complete = scripted([
    turn([id('list_accounts', 1, {}), id('list_accounts', 2, {})]),
    turn(),
  ]);
  const result = await runConversation({ db, messages: [], backend: backend(complete) });
  expect(result.failed).toBe(false);
  expect(result.trace.turns[0]!.repeatedCalls).toEqual([
    {
      callId: 'list_accounts-2',
      name: 'list_accounts',
      occurrence: 2,
      action: 'no_progress_response',
    },
  ]);
});
it('cancellation still wins during a repeated batch', async () => {
  const controller = new AbortController();
  let i = 0;
  const complete = vi.fn(async () => {
    await Promise.resolve();
    if (i++ === 1) controller.abort();
    return turn([id('list_accounts', i, {})]);
  });
  const result = await runConversation({
    db,
    messages: [],
    backend: backend(complete),
    signal: controller.signal,
  });
  expect(result.reason).toBe('cancelled');
  expect(complete).toHaveBeenCalledTimes(2);
});
it('resets signature state on the next user request', async () => {
  const messages = [{ role: 'user' as const, text: 'accounts?' }];
  const first = await runConversation({
    db,
    messages,
    backend: backend(scripted([turn([id('list_accounts', 1, {})]), turn()])),
  });
  expect(first.reason).toBe('answered');
  const again = await runConversation({
    db,
    messages: [...first.messages, { role: 'user', text: 'accounts again?' }],
    backend: backend(scripted([turn([id('list_accounts', 1, {})]), turn()])),
  });
  expect(again.reason).toBe('answered');
  expect(again.trace.turns[0]!.repeatedCalls).toEqual([]);
});
// Final money and percentage claims need typed values from this request's tools.
const figures = (text: string): Turn => ({ ...turn(), text });
it('withholds a first unsupported amount, then accepts an answer without a figure', async () => {
  const lastSeen: string[] = [];
  const complete = vi.fn().mockImplementation((req: CompleteRequest) => {
    const last = req.messages.at(-1);
    lastSeen.push(last?.role === 'user' ? last.text : (last?.role ?? ''));
    return Promise.resolve(
      [
        figures('Dining out came to £1,363 last quarter.'),
        turn([call()]),
        figures('No matching transactions were found.'),
      ][lastSeen.length - 1]!,
    );
  });
  const events: ChatEvent[] = [];
  const result = await runConversation({
    db,
    backend: backend(complete),
    messages: [{ role: 'user', text: 'Where does my dining money go?' }],
    onEvent: (e) => events.push(e),
  });
  expect(result.failed).toBe(false);
  expect(result.text).toBe('No matching transactions were found.');
  expect(result.trace.turns.map((t) => t.unverified)).toEqual([true, undefined, undefined]);
  expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'text')).toEqual([
    { type: 'text', text: 'No matching transactions were found.' },
  ]);
  expect(lastSeen[1]).toMatch(/absent from the successful tool results/);
});
it('rejects a hallucinated amount after a successful tool call without showing streamed text', async () => {
  const { upsertAccount, upsertTransactions } = await import('../../src/db/repo.js');
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'Test', currency: 'AUD', raw: {} });
  upsertTransactions(db, [
    {
      source: 'test',
      externalId: 'one',
      accountExternalId: 'a',
      postedAt: '2026-09-01T00:00:00Z',
      amountCents: -2599,
      currency: 'AUD',
      descriptionRaw: 'Netflix',
      descriptionNorm: 'netflix',
      status: 'posted',
      raw: {},
    },
  ]);
  let turnNumber = 0;
  const complete = vi.fn((req: CompleteRequest) => {
    turnNumber++;
    if (turnNumber === 1) return Promise.resolve(turn([call()]));
    if (turnNumber === 2) {
      req.onText?.('The charge was AUD 999.00.');
      return Promise.resolve(figures('The charge was AUD 999.00.'));
    }
    return Promise.resolve(figures('The charge was AUD 25.99.'));
  });
  const events: ChatEvent[] = [];
  const result = await runConversation({
    db,
    backend: backend(complete),
    messages: [{ role: 'user', text: 'How much was Netflix?' }],
    onEvent: (e) => events.push(e),
  });
  expect(result.reason).toBe('answered');
  expect(result.text).toBe('The charge was AUD 25.99.');
  expect(result.trace.turns.map((t) => t.unverified)).toEqual([undefined, true, undefined]);
  expect(events.filter((e) => e.type === 'text')).toEqual([
    { type: 'text', text: 'The charge was AUD 25.99.' },
  ]);
});
it('ends the request when the retry still quotes unsupported figures', async () => {
  const complete = vi
    .fn()
    .mockResolvedValueOnce(figures('You spent 12% more.'))
    .mockResolvedValueOnce(figures('About $500 a month.'));
  const result = await runConversation({
    db,
    backend: backend(complete),
    messages: [{ role: 'user', text: 'Am I overspending?' }],
  });
  expect(result.failed).toBe(true);
  expect(result.reason).toBe('unverified_answer');
  expect(complete).toHaveBeenCalledTimes(2);
});
it('takes money and percentages only from typed result fields, with currency and rounding', () => {
  const result = JSON.stringify({
    currency: 'AUD',
    total: { cents: 109825, decimal: '1098.25' },
    other: { cents: 2599, decimal: '25.99' },
    percentage_change: 13.05,
    id: 3000,
    description: 'Reference $2000',
    date_range: { from: '2026-09-01' },
  });
  expect(unevidencedFigures('AUD 1,098 and 13% on A$25.99.', [result])).toEqual([]);
  expect(unevidencedFigures('AUD 3,000 or $2,000', [result])).toEqual(['AUD 3,000', '$2,000']);
  expect(unevidencedFigures('USD 25.99 and 12%', [result])).toEqual(['USD 25.99', '12%']);
  expect(unevidencedFigures('USD $25.99', [result])).toEqual(['$25.99']);
  expect(unevidencedFigures('16 transactions over 15 days in 2026.', [])).toEqual([]);
  expect(unevidencedFigures('£1,363 last quarter', [])).toEqual(['£1,363']);
});
it('checks the direction of a percentage change against the signed tool result', () => {
  const result = JSON.stringify({ percentage_change: -34.4 });
  expect(unevidencedFigures('Spending fell 34.4%.', [result])).toEqual([]);
  expect(unevidencedFigures('That is a 34.4% decrease.', [result])).toEqual([]);
  expect(unevidencedFigures('That is a 34.4% increase.', [result])).toEqual(['34.4%']);
  expect(unevidencedFigures('Spending changed by +34.4%.', [result])).toEqual(['+34.4%']);
  expect(unevidencedFigures('Spending changed by -34.4%.', [result])).toEqual([]);
});
it('does not treat the user or an earlier model answer as tool evidence', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', text: 'What needs my attention?' },
    { role: 'assistant', text: 'Netflix costs $25.99.', toolCalls: [] },
    { role: 'user', text: 'Is the $25.99 still right?' },
  ];
  const complete = vi.fn().mockResolvedValue(figures('It is still $25.99.'));
  const result = await runConversation({ db, backend: backend(complete), messages });
  expect(result.reason).toBe('unverified_answer');
  expect(complete).toHaveBeenCalledTimes(2);
});
it('allows a tool-free answer with no monetary claim', async () => {
  const complete = vi.fn().mockResolvedValue(figures('I can search imported transactions.'));
  const result = await runConversation({
    db,
    backend: backend(complete),
    messages: [{ role: 'user', text: 'What can you do?' }],
  });
  expect(result.reason).toBe('answered');
  expect(complete).toHaveBeenCalledTimes(1);
});
