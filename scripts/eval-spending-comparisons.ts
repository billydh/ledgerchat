/**
 * Opt-in live evaluation against a local model, using only synthetic transactions.
 * Run: pnpm exec tsx scripts/eval-spending-comparisons.ts
 * Fast guard audit: pnpm exec tsx scripts/eval-spending-comparisons.ts --audit-only
 * Selected live cases: pnpm exec tsx scripts/eval-spending-comparisons.ts --cases=6,7,9
 */
import { openMemoryDb } from '../src/db/client.js';
import { upsertAccount, upsertTransactions } from '../src/db/repo.js';
import { createBackend } from '../src/llm/backend.js';
import { runConversation } from '../src/chat/orchestrator.js';
import { asksForSpendingComparison, renderSpendingComparison } from '../src/chat/comparison.js';
import { executeTool } from '../src/tools/registry.js';

const cases = [
  {
    name: 'full months',
    question: 'How did my food and drink spending change between July and August 2026?',
    expected: ['AUD 1,226.32', 'AUD 1,869.40', 'AUD 643.08 more'],
  },
  {
    name: 'reversed phrasing and percentage',
    question:
      'Compare August 2026 food and drink spending with July 2026. What percentage did it increase?',
    expected: ['AUD 1,226.32', 'AUD 1,869.40', '52.44% increase'],
  },
  {
    name: 'grocery subcategory',
    question: 'Was grocery spending higher in August than July 2026?',
    expected: ['AUD 900.00', 'AUD 1,500.00', 'AUD 600.00 more'],
  },
  {
    name: 'fuel subcategory',
    question: 'How much more did I spend on fuel in August than July 2026?',
    expected: ['AUD 100.00', 'AUD 200.00', 'AUD 100.00 more'],
  },
  {
    name: 'transport category',
    question: 'Compare transport spending in July and August 2026.',
    expected: ['AUD 100.00', 'AUD 200.00', 'AUD 100.00 more'],
  },
  {
    name: 'merchant filter',
    question: 'How did my Woolworths spending change between July and August 2026?',
    expected: ['AUD 900.00', 'AUD 1,500.00', 'AUD 600.00 more'],
  },
  {
    name: 'partial months',
    question: 'How did my food and drink spending change from 1–15 July to 1–15 August 2026?',
    expected: ['AUD 900.00', 'AUD 1,500.00', 'AUD 600.00 more'],
  },
  {
    name: 'higher-or-lower phrasing',
    question: 'Did I spend more on food and drink in July or August 2026?',
    expected: ['AUD 1,226.32', 'AUD 1,869.40', 'AUD 643.08 more'],
  },
  {
    name: 'expense synonym',
    question: 'Compare my expenses in July and August 2026.',
    expected: ['AUD 1,326.32', 'AUD 2,069.40', 'AUD 743.08 more'],
  },
  {
    name: 'relative months',
    question: 'Compare my food and drink spending this month with last month.',
    expected: ['AUD 0.00', 'AUD 1,869.40', 'AUD 1,869.40 less'],
  },
  {
    name: 'multi-part merchants',
    question: 'Compare food spending in July and August 2026, and list top merchants.',
    expected: ['1,226.32', '1,869.40', 'woolworths', 'cafe'],
  },
  {
    name: 'named account',
    question:
      'Compare food and drink spending on my Synthetic account between July and August 2026.',
    expected: ['AUD 1,226.32', 'AUD 1,869.40', 'AUD 643.08 more'],
  },
  {
    name: 'transfers requested',
    question: 'Compare my spending including transfers between July and August 2026.',
    expected: ['AUD 1,326.32', 'AUD 2,069.40', 'AUD 743.08 more'],
  },
  {
    name: 'yearless recent months',
    question: 'Compare food and drink spending in July and August.',
    expected: ['AUD 1,226.32', 'AUD 1,869.40', 'AUD 643.08 more'],
  },
] as const;

const db = openMemoryDb();
upsertAccount(db, { source: 'eval', externalId: 'a', name: 'Synthetic', currency: 'AUD', raw: {} });
const rows = [
  ['2026-07-10', 'woolworths', -90000, 'groceries'],
  ['2026-07-20', 'cafe', -32632, 'dining'],
  ['2026-08-10', 'woolworths', -150000, 'groceries'],
  ['2026-08-20', 'cafe', -36940, 'dining'],
  ['2026-07-12', 'petrol', -10000, 'fuel'],
  ['2026-08-12', 'petrol', -20000, 'fuel'],
] as const;
upsertTransactions(
  db,
  rows.map(([date, description, amount, _subcategory], index) => ({
    source: 'eval',
    externalId: String(index),
    accountExternalId: 'a',
    postedAt: `${date}T12:00:00Z`,
    amountCents: amount,
    currency: 'AUD',
    descriptionRaw: description,
    descriptionNorm: description,
    status: 'posted' as const,
    raw: {},
  })),
);
for (const [, description, , subcategory] of rows)
  db.prepare<[string, string]>(
    "UPDATE transactions SET subcategory = ?, category_source = 'llm' WHERE description_norm = ?",
  ).run(subcategory, description);

const auditCases = [
  {
    name: 'matching category and months',
    question: 'Compare food and drink spending between July and August 2026.',
    input: {
      group_by: 'category',
      category: 'food_drink',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: true,
  },
  {
    name: 'wrong category',
    question: 'Compare food and drink spending between July and August 2026.',
    input: {
      group_by: 'category',
      category: 'transport',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'wrong full month',
    question: 'Compare food and drink spending between July and August 2026.',
    input: {
      group_by: 'category',
      category: 'food_drink',
      from: '2026-09-01',
      to: '2026-09-30',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'merchant filter omitted',
    question: 'How did my Woolworths spending change between July and August 2026?',
    input: {
      group_by: 'merchant',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'partial dates replaced by full months',
    question: 'How did my food and drink spending change from 1–15 July to 1–15 August 2026?',
    input: {
      group_by: 'category',
      category: 'food_drink',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'health scope omitted',
    question: 'Compare health spending between July and August 2026.',
    input: {
      group_by: 'subcategory',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'unrequested account filter',
    question: 'Compare spending between July and August 2026.',
    input: {
      group_by: 'account',
      account_id: 1,
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'unrequested internal transfers',
    question: 'Compare spending between July and August 2026.',
    input: {
      group_by: 'category',
      include_transfers: true,
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'wrong relative months',
    question: 'Compare spending this month with last month.',
    input: {
      group_by: 'month',
      from: '2024-08-01',
      to: '2024-08-31',
      compare_from: '2024-07-01',
      compare_to: '2024-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'top merchants without merchant grouping',
    question: 'Compare food spending in July and August 2026, and list top merchants.',
    input: {
      group_by: 'category',
      category: 'food_drink',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'top merchants with matching grouped comparison',
    question: 'Compare food spending in July and August 2026, and list top merchants.',
    input: {
      group_by: 'merchant',
      category: 'food_drink',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: true,
  },
  {
    name: 'named card filter omitted',
    question: 'Compare food spending on my Synthetic card between July and August 2026.',
    input: {
      group_by: 'category',
      category: 'food_drink',
      from: '2026-08-01',
      to: '2026-08-31',
      compare_from: '2026-07-01',
      compare_to: '2026-07-31',
    },
    shouldAccept: false,
  },
  {
    name: 'yearless months resolved to wrong year',
    question: 'Compare food spending in July and August.',
    input: {
      group_by: 'category',
      category: 'food_drink',
      from: '2025-08-01',
      to: '2025-08-31',
      compare_from: '2025-07-01',
      compare_to: '2025-07-31',
    },
    shouldAccept: false,
  },
] as const;

try {
  let auditPassed = 0;
  for (const item of auditCases) {
    const tool = executeTool(db, 'get_spending_summary', item.input, {
      now: new Date('2026-09-23T12:00:00Z'),
    });
    const accepted =
      !tool.isError &&
      renderSpendingComparison(item.question, tool.content, {
        descriptions: rows.map(([, description]) => description),
        accounts: [{ id: 1, name: 'Synthetic' }],
        now: new Date('2026-09-23T12:00:00Z'),
        groupBy: item.input.group_by,
      }) !== null;
    const pass = accepted === item.shouldAccept;
    if (pass) auditPassed++;
    console.log(
      JSON.stringify({ audit: item.name, pass, accepted, shouldAccept: item.shouldAccept }),
    );
  }
  console.log(JSON.stringify({ auditSummary: { passed: auditPassed, total: auditCases.length } }));
  const expenseQuestion = cases[8].question;
  console.log(
    JSON.stringify({
      routingAudit: 'expense synonym',
      pass: asksForSpendingComparison(expenseQuestion),
      routed: asksForSpendingComparison(expenseQuestion),
      shouldRoute: true,
    }),
  );
  const multipart = 'Compare food spending in July and August 2026, and list top merchants.';
  console.log(
    JSON.stringify({
      routingAudit: 'comparison plus top merchants',
      pass: asksForSpendingComparison(multipart),
      routed: asksForSpendingComparison(multipart),
      shouldRoute: true,
    }),
  );
  const unsupportedMultipart =
    'Compare food spending in July and August 2026, and list my latest transactions.';
  console.log(
    JSON.stringify({
      routingAudit: 'comparison plus transactions',
      pass: !asksForSpendingComparison(unsupportedMultipart),
      routed: asksForSpendingComparison(unsupportedMultipart),
      shouldRoute: false,
    }),
  );
  if (!process.argv.includes('--audit-only')) {
    const backend = createBackend(process.env.CHAT_LIVE_BACKEND ?? 'local/Qwen3.8-27B-4bit', {
      env: {
        ...process.env,
        LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:8000',
        LOCAL_LLM_THINKING: 'false',
      },
    });
    let passed = 0;
    const only = process.argv.find((arg) => arg.startsWith('--cases='))?.slice('--cases='.length);
    const selectedNumbers = only?.split(',').filter(Boolean);
    const selected = [...cases.entries()].filter(
      ([index]) => !selectedNumbers || selectedNumbers.includes(String(index + 1)),
    );
    for (const [index, item] of selected) {
      const started = Date.now();
      const result = await runConversation({
        db,
        backend,
        now: new Date('2026-09-23T12:00:00Z'),
        messages: [{ role: 'user', text: item.question }],
        signal: AbortSignal.timeout(120000),
      });
      const ok = !result.failed && item.expected.every((value) => result.text.includes(value));
      if (ok) passed++;
      const calls = result.trace.turns.flatMap((turn) =>
        turn.toolCalls.map((call) => ({
          name: call.name,
          input: call.rawInput,
        })),
      );
      console.log(
        JSON.stringify({
          case: index + 1,
          name: item.name,
          pass: ok,
          elapsedMs: Date.now() - started,
          reason: result.reason,
          calls,
          answer: result.text,
        }),
      );
    }
    const total = selected.length;
    console.log(JSON.stringify({ liveSummary: { passed, total } }));
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  db.close();
}
