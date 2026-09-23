/** Live, opt-in evaluation of app-rendered balance and cash-flow answers using synthetic data. */
import { openMemoryDb } from '../src/db/client.js';
import { insertBalances, upsertAccount, upsertTransactions } from '../src/db/repo.js';
import { createBackend } from '../src/llm/backend.js';
import { runConversation } from '../src/chat/orchestrator.js';

const db = openMemoryDb();
const accountId = upsertAccount(db, {
  source: 'eval',
  externalId: 'a',
  name: 'Synthetic',
  currency: 'AUD',
  raw: {},
});
insertBalances(db, [
  {
    accountId,
    asOf: '2026-09-11T05:00:00.000Z',
    currentCents: 74777,
    currency: 'AUD',
    raw: {},
  },
]);
upsertTransactions(
  db,
  [
    ['2026-08-10', 20000],
    ['2026-08-12', -10000],
  ].map(([date, cents], index) => ({
    source: 'eval',
    externalId: String(index),
    accountExternalId: 'a',
    postedAt: `${String(date)}T12:00:00Z`,
    amountCents: Number(cents),
    currency: 'AUD',
    descriptionRaw: `synthetic ${String(index)}`,
    descriptionNorm: `synthetic ${String(index)}`,
    status: 'posted' as const,
    raw: {},
  })),
);

const backend = createBackend(process.env.CHAT_LIVE_BACKEND ?? 'local/Qwen3.8-27B-4bit', {
  env: {
    ...process.env,
    LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:8000',
    LOCAL_LLM_THINKING: 'false',
  },
});
const cases = [
  {
    name: 'named card balance',
    question: 'What is my Synthetic card balance?',
    expected: ['Synthetic: current **AUD 747.77**', '11 Sept 2026'],
  },
  {
    name: 'last month cash flow',
    question: 'What actually came in and went out last month?',
    expected: [
      'incoming credits: **AUD 200.00**',
      'outgoing debits: **AUD 100.00**',
      'net flow: **AUD 100.00**',
    ],
  },
] as const;

try {
  let passed = 0;
  for (const item of cases) {
    const started = Date.now();
    const result = await runConversation({
      db,
      backend,
      now: new Date('2026-09-23T12:00:00Z'),
      messages: [{ role: 'user', text: item.question }],
      signal: AbortSignal.timeout(90000),
    });
    const pass = !result.failed && item.expected.every((part) => result.text.includes(part));
    if (pass) passed++;
    console.log(
      JSON.stringify({
        name: item.name,
        pass,
        elapsedMs: Date.now() - started,
        reason: result.reason,
        calls: result.trace.turns.flatMap((turn) =>
          turn.toolCalls.map((call) => ({
            name: call.name,
            input: call.rawInput,
          })),
        ),
        answer: result.text,
      }),
    );
  }
  console.log(JSON.stringify({ liveSummary: { passed, total: cases.length } }));
  if (passed !== cases.length) process.exitCode = 1;
} finally {
  db.close();
}
