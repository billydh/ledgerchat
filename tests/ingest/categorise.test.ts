import { afterEach, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../src/db/client.js';
import { upsertAccount, upsertTransactions } from '../../src/db/repo.js';
import { categorise } from '../../src/ingest/categorise.js';
import { setCorrection } from '../../src/ingest/corrections.js';
import {
  categoryOf,
  classificationRules,
  parentCategories,
  parentCategoryLabels,
  parentOf,
  subcategoriesOf,
  subcategories,
  subcategoryGlosses,
  subcategorySchema,
} from '../../src/ingest/taxonomy.js';
import { getCapabilities } from '../../src/llm/capabilities.js';
import type { CompleteRequest, Turn } from '../../src/llm/types.js';

const dbs: ReturnType<typeof openMemoryDb>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function seed(count: number) {
  const db = openMemoryDb();
  dbs.push(db);
  upsertAccount(db, {
    source: 'test',
    externalId: 'account',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertTransactions(
    db,
    Array.from({ length: count }, (_, i) => ({
      source: 'test',
      externalId: String(i),
      accountExternalId: 'account',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -100,
      currency: 'AUD',
      descriptionRaw: `SHOP ${String(i).padStart(3, '0')}`,
      descriptionNorm: `SHOP ${String(i).padStart(3, '0')}`,
      status: 'posted' as const,
      raw: {},
    })),
  );
  return db;
}
function seedDescriptions(descriptions: string[]) {
  const db = openMemoryDb();
  dbs.push(db);
  upsertAccount(db, {
    source: 'test',
    externalId: 'account',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertTransactions(
    db,
    descriptions.map((description, i) => ({
      source: 'test',
      externalId: String(i),
      accountExternalId: 'account',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -100,
      currency: 'AUD',
      descriptionRaw: description,
      descriptionNorm: description,
      status: 'posted' as const,
      raw: {},
    })),
  );
  return db;
}
function answer(request: CompleteRequest): Turn {
  const first = request.messages[0]!;
  if (first.role !== 'user') throw new Error('Expected prompt');
  const descriptions = JSON.parse(first.text.split('Descriptions (JSON):\n')[1]!) as string[];
  return {
    text: '',
    toolCalls: [
      {
        id: 'submit-1',
        name: 'submit',
        rawInput: {
          items: descriptions.map((description) => ({
            description,
            subcategory: 'shopping',
            confidence: 0.8,
            transfer_hint: false,
            is_subscription: null,
          })),
        },
      },
    ],
    stopReason: 'tool_calls',
    usage: { inputTokens: 10, outputTokens: 20 },
    latencyMs: 0,
  };
}
function fake() {
  return {
    label: 'local/test',
    capabilities: getCapabilities(),
    complete: vi.fn((request: CompleteRequest) => Promise.resolve(answer(request))),
  };
}

it('exports a matching enum and gloss map with other as fallback', () => {
  expect(Object.keys(subcategoryGlosses).sort()).toEqual([...subcategories].sort());
  expect(subcategorySchema.options).toEqual(subcategories);
  expect(subcategorySchema.parse('other')).toBe('other');
  expect(Object.keys(parentCategoryLabels).sort()).toEqual([...parentCategories].sort());
  expect(parentCategories).toHaveLength(13);
  expect(subcategories).toHaveLength(38);
});

it('maps every leaf to exactly one parent and never shares an identifier with one', () => {
  expect(Object.keys(parentOf).sort()).toEqual([...subcategories].sort());
  for (const leaf of subcategories) {
    expect(parentCategories).toContain(parentOf[leaf]);
    expect(subcategoriesOf[parentOf[leaf]]).toContain(leaf);
  }
  // Absolute, including single-leaf parents: the two tool filters mean different
  // things, so a shared identifier would let a caller pass one meaning the other.
  expect(subcategories.filter((leaf) => (parentCategories as string[]).includes(leaf))).toEqual([]);
  expect(new Set(subcategories).size).toBe(subcategories.length);
});

it('gives every multi-leaf parent exactly one _other leaf and single-leaf parents none', () => {
  for (const parent of parentCategories) {
    const leaves = subcategoriesOf[parent];
    const escapes = leaves.filter((leaf) => leaf === `${parent}_other`);
    if (parent === 'uncategorised') {
      expect(leaves).toEqual(['other']);
      continue;
    }
    expect(escapes).toHaveLength(leaves.length > 1 ? 1 : 0);
  }
});

it('rejects removed and renamed labels, and derives parents for null and unknown labels', () => {
  for (const retired of [
    'rent_mortgage',
    'gifts_donations',
    'fees_interest',
    'subscriptions',
    'transfer_hint_only',
    'transport',
    'insurance',
    'education',
    'cash',
  ]) {
    expect(subcategorySchema.safeParse(retired).success).toBe(false);
  }
  expect(categoryOf(null)).toBe('uncategorised');
  expect(categoryOf('rent_mortgage')).toBe('uncategorised');
  expect(categoryOf('cash_movement')).toBe('cash');
  expect(categoryOf('rent')).toBe('housing');
});

it('names every leaf this taxonomy added, split or renamed', () => {
  for (const leaf of [
    'vehicle_maintenance',
    'home_maintenance',
    'personal_care',
    'fitness',
    'income_benefits',
    'tax',
    'loan_repayment',
    'savings',
    'investments',
    'food_drink_other',
    'transport_other',
    'health_wellbeing_other',
    'financial_costs_other',
    'savings_investments_other',
    'rent',
    'mortgage',
    'gifts',
    'donations',
    'bank_fees',
    'interest_charged',
    'public_transport',
    'insurance_premiums',
    'tuition_courses',
    'cash_movement',
  ]) {
    expect(subcategories).toContain(leaf);
    expect(subcategoryGlosses[leaf as keyof typeof subcategoryGlosses]).toBeTruthy();
  }
});

it('batches 120 descriptions, persists metadata, and makes no calls on a second run', async () => {
  const db = seed(120);
  const backend = fake();
  expect(await categorise(db, backend)).toMatchObject({
    newDescriptions: 120,
    categorisedDescriptions: 120,
    batches: 3,
    failures: [],
    transactionsUpdated: 120,
    attempts: 3,
    usage: { inputTokens: 30, outputTokens: 60 },
  });
  expect(backend.complete).toHaveBeenCalledTimes(3);
  expect(
    db
      .prepare(
        'SELECT subcategory, confidence, transfer_hint, is_subscription, model FROM description_categories LIMIT 1',
      )
      .get(),
  ).toEqual({
    subcategory: 'shopping',
    confidence: 0.8,
    transfer_hint: 0,
    is_subscription: null,
    model: 'local/test',
  });
  // The model chose a leaf only; the parent is derived, never stored.
  const labelled = db
    .prepare<[], { subcategory: string; is_subscription: null }>(
      'SELECT subcategory, is_subscription FROM transactions LIMIT 1',
    )
    .get()!;
  expect(labelled).toEqual({ subcategory: 'shopping', is_subscription: null });
  expect(categoryOf(labelled.subcategory)).toBe('lifestyle');
  expect(
    db
      .prepare("SELECT count(*) AS n FROM pragma_table_info('transactions') WHERE name='category'")
      .get(),
  ).toEqual({ n: 0 });
  backend.complete.mockClear();
  expect(await categorise(db, backend)).toMatchObject({
    newDescriptions: 0,
    batches: 0,
    transactionsUpdated: 0,
  });
  expect(backend.complete).not.toHaveBeenCalled();
});

it.each(['missing', 'duplicate', 'reordered', 'hallucinated'])(
  'retries %s echoes without persisting them',
  async (kind) => {
    const db = seed(3);
    const backend = fake();
    backend.complete.mockImplementationOnce((request) => {
      const response = answer(request);
      const raw = response.toolCalls[0]!.rawInput as { items: { description: string }[] };
      if (kind === 'missing') raw.items.pop();
      if (kind === 'duplicate') raw.items[1]!.description = raw.items[0]!.description;
      if (kind === 'reordered') raw.items.reverse();
      if (kind === 'hallucinated') raw.items[0]!.description = 'MADE UP';
      return Promise.resolve(response);
    });
    expect(await categorise(db, backend)).toMatchObject({
      categorisedDescriptions: 3,
      attempts: 2,
      failures: [],
    });
    expect(backend.complete.mock.calls[1]![0].messages[2]).toMatchObject({ role: 'tool' });
    expect(db.prepare('SELECT count(*) AS n FROM description_categories').get()).toEqual({ n: 3 });
  },
);

it('reports an exhausted batch, continues, and resumes only failed descriptions', async () => {
  const db = seed(120);
  const backend = fake();
  const bad = () =>
    Promise.resolve({
      ...answer({
        messages: [{ role: 'user', text: 'Descriptions (JSON):\n[]' }],
      } as CompleteRequest),
    });
  backend.complete
    .mockImplementationOnce(bad)
    .mockImplementationOnce(bad)
    .mockImplementationOnce(bad);
  const result = await categorise(db, backend);
  expect(result).toMatchObject({ batches: 3, categorisedDescriptions: 70, attempts: 5 });
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]!.descriptions).toHaveLength(50);
  backend.complete.mockClear();
  expect(await categorise(db, backend)).toMatchObject({
    newDescriptions: 50,
    categorisedDescriptions: 50,
    failures: [],
  });
  expect(backend.complete).toHaveBeenCalledTimes(1);
});

it('keeps completed batches when a later transport fails', async () => {
  const db = seed(51);
  const backend = fake();
  backend.complete
    .mockImplementationOnce((req) => Promise.resolve(answer(req)))
    .mockRejectedValueOnce(new Error('Offline'));
  expect(await categorise(db, backend)).toMatchObject({
    categorisedDescriptions: 50,
    failures: [{ error: 'Offline' }],
  });
  expect(
    db.prepare("SELECT count(*) AS n FROM transactions WHERE category_source = 'llm'").get(),
  ).toEqual({ n: 50 });
  expect(await categorise(db, backend)).toMatchObject({
    newDescriptions: 1,
    categorisedDescriptions: 1,
  });
});

it('preserves corrections through recategorisation and applies cache to new duplicates', async () => {
  const db = seed(3);
  const backend = fake();
  setCorrection(db, 1, 'transaction', 'donations');
  await categorise(db, backend);
  await categorise(db, backend, { recategorise: true });
  expect(
    db
      .prepare(
        "SELECT subcategory, category_source, category_origin, machine_subcategory FROM transactions WHERE external_id='0'",
      )
      .get(),
  ).toEqual({
    subcategory: 'donations',
    category_source: 'manual',
    category_origin: 'transaction_override',
    machine_subcategory: 'shopping',
  });
  db.prepare(
    "UPDATE transactions SET subcategory=NULL, machine_subcategory=NULL, category_source=NULL, category_origin=NULL WHERE external_id='1'",
  ).run();
  backend.complete.mockClear();
  expect(await categorise(db, backend)).toMatchObject({
    transactionsUpdated: 1,
    newDescriptions: 0,
  });
  expect(backend.complete).not.toHaveBeenCalled();
  expect(
    db.prepare("SELECT subcategory, category_origin FROM transactions WHERE external_id='1'").get(),
  ).toEqual({ subcategory: 'shopping', category_origin: 'llm' });
});

it('does not persist a batch with invalid confidence or taxonomy', async () => {
  const db = seed(1);
  const backend = fake();
  backend.complete.mockImplementation((request) => {
    const response = answer(request);
    response.toolCalls[0]!.rawInput = {
      items: [
        { description: 'SHOP 000', subcategory: 'invented', confidence: 2, transfer_hint: false },
      ],
    };
    return Promise.resolve(response);
  });
  expect((await categorise(db, backend)).failures).toHaveLength(1);
  expect(db.prepare('SELECT count(*) AS n FROM description_categories').get()).toEqual({ n: 0 });
});

it('resolves split leaves distinctly and falls back to the parent _other leaf', async () => {
  // The model returns one leaf per description; every parent below is derived.
  const labels: Record<string, string> = {
    'MONTHLY RENT THOMAS': 'rent',
    'HOME LOAN REPAYMENT CBA': 'mortgage',
    'HOUSING PAYMENT': 'housing_other',
    'BIRTHDAY GIFT FOR SAM': 'gifts',
    'RED CROSS DONATION': 'donations',
    GIVING: 'giving_other',
    'NETFLIX.COM': 'entertainment',
    'ANYTIME FITNESS': 'fitness',
  };
  const db = seedDescriptions(Object.keys(labels));
  const backend = fake();
  backend.complete.mockImplementation((request) => {
    const response = answer(request);
    const raw = response.toolCalls[0]!.rawInput as {
      items: { description: string; subcategory: string; is_subscription: boolean | null }[];
    };
    for (const item of raw.items) {
      item.subcategory = labels[item.description]!;
      // Independent of the leaf: two different parents can both be subscriptions.
      item.is_subscription = ['NETFLIX.COM', 'ANYTIME FITNESS'].includes(item.description)
        ? true
        : null;
    }
    return Promise.resolve(response);
  });
  expect(await categorise(db, backend)).toMatchObject({ failures: [], categorisedDescriptions: 8 });
  const rows = db
    .prepare<[], { description_norm: string; subcategory: string; is_subscription: number | null }>(
      'SELECT description_norm, subcategory, is_subscription FROM transactions ORDER BY description_norm',
    )
    .all();
  expect(
    rows.map((r) => [r.subcategory, categoryOf(r.subcategory), r.is_subscription]),
  ).toStrictEqual([
    ['fitness', 'health_wellbeing', 1],
    ['gifts', 'giving', null],
    ['giving_other', 'giving', null],
    ['mortgage', 'housing', null],
    ['housing_other', 'housing', null],
    ['rent', 'housing', null],
    ['entertainment', 'lifestyle', 1],
    ['donations', 'giving', null],
  ]);
  // A second run over unchanged data reuses the cache and calls no model.
  backend.complete.mockClear();
  expect(await categorise(db, backend)).toMatchObject({ newDescriptions: 0, batches: 0 });
  expect(backend.complete).not.toHaveBeenCalled();
});

it('sends every rule, parent and leaf to the model in the prompt', async () => {
  const db = seedDescriptions(['ATM WITHDRAWAL']);
  const backend = fake();
  await categorise(db, backend);
  const first = backend.complete.mock.calls[0]![0].messages[0]!;
  if (first.role !== 'user') throw new Error('Expected a user prompt');
  const prompt = first.text;
  // The rules carry the precedence boundaries the glosses leave ambiguous; a
  // silent drop would change classification with nothing failing.
  for (const rule of classificationRules) expect(prompt).toContain(rule);
  for (const parent of parentCategories) expect(prompt).toContain(`${parent} (`);
  for (const leaf of subcategories) expect(prompt).toContain(`  ${leaf}: `);
  expect(prompt).toContain('named third party');
  expect(prompt).toContain('is_subscription');
});
