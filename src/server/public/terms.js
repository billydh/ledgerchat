// Plain-language layer: one place that turns internal vocabulary (reporting
// classes, reconciliation states, tool names) into the words the interface
// shows. Every script imports from here so the wording never drifts.
export const CLASS_LABELS = {
  consumption: 'Spending',
  income: 'Income',
  internal_transfer: 'Moved between your accounts',
  asset_movement: 'Saved or invested',
  liability_principal: 'Loan principal',
  unresolved_movement: 'Not yet classified',
};
export const classLabel = (cls) => CLASS_LABELS[cls] ?? String(cls ?? '').replaceAll('_', ' ');
export const CADENCE_LABELS = {
  weekly: 'Weekly',
  fortnightly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly',
  once: 'Once',
};
export const cadenceLabel = (c) => CADENCE_LABELS[c] ?? String(c ?? '');
/**
 * Reconciliation in words. `format` renders cents in the account's currency so
 * the gap can be named; the tone drives the badge colour.
 */
export function reconciliationLabel(state, format = (cents) => String(cents)) {
  switch (state?.status) {
    case 'matched':
      return { text: 'Matches your statement', tone: 'ok' };
    case 'unexplained':
      return {
        text: `Gap of ${format(Math.abs(state.unexplained_cents ?? 0))} vs statement`,
        tone: 'warn',
      };
    case 'unverified':
      return { text: 'One statement balance, not checked', tone: 'muted' };
    case 'no_balance':
      return { text: 'No statement balance', tone: 'muted' };
    default:
      return { text: 'Balance unknown', tone: 'muted' };
  }
}
export const TOOL_LABELS = {
  list_accounts: 'Listed your accounts',
  search_transactions: 'Searched transactions',
  get_spending_summary: 'Summarised spending',
  get_cash_flow: 'Worked out money in and out',
  get_recurring_charges: 'Looked for regular charges',
  get_upcoming_payments: 'Estimated upcoming payments',
};
export const toolLabel = (name) => TOOL_LABELS[name] ?? `Ran ${String(name ?? '')}`;
const PERIOD_WORDS = {
  this_month: 'this month',
  last_month: 'last month',
  last_30_days: 'the last 30 days',
  ytd: 'this year so far',
};
const humanKey = (key) => key.replaceAll('_', ' ');
/** One readable line for a tool call's arguments, e.g. "groceries · 2026-08-01 to 2026-08-31". */
export function describeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  const i = input;
  if (i.query) parts.push(`"${i.query}"`);
  if (i.subcategory) parts.push(humanKey(String(i.subcategory)));
  else if (i.category) parts.push(humanKey(String(i.category)));
  if (i.period) parts.push(PERIOD_WORDS[i.period] ?? humanKey(String(i.period)));
  else if (i.from || i.to) parts.push(`${i.from ?? '…'} to ${i.to ?? '…'}`);
  if (i.compare_period) parts.push(`vs ${PERIOD_WORDS[i.compare_period] ?? i.compare_period}`);
  else if (i.compare_from || i.compare_to)
    parts.push(`vs ${i.compare_from ?? '…'} to ${i.compare_to ?? '…'}`);
  if (i.group_by) parts.push(`by ${humanKey(String(i.group_by))}`);
  if (i.direction && i.direction !== 'all')
    parts.push(i.direction === 'debit' ? 'money out' : 'money in');
  if (i.account_id) parts.push(`account ${i.account_id}`);
  if (i.days) parts.push(`next ${i.days} days`);
  if (i.min_occurrences) parts.push(`${i.min_occurrences}+ charges`);
  if (i.limit && name === 'search_transactions') parts.push(`up to ${i.limit}`);
  return parts.join(' · ');
}
/** Glossary shown under "About these numbers" and in the info popovers. */
export const GLOSSARY = {
  spending: {
    title: 'Spending',
    text: 'Money that left your accounts for goods and services. Transfers between your own accounts, savings, investments, loan repayments and pending rows are not spending.',
  },
  income: {
    title: 'Income',
    text: 'Money that arrived and is labelled as income, such as salary or interest. Refunds and transfers in are not income.',
  },
  left_over: {
    title: 'Left over',
    text: 'Income minus spending for the period. It is not a balance: money you moved to savings or paid off a loan with is neither counted nor subtracted.',
  },
  balance: {
    title: 'Statement balance',
    text: 'The balance your bank stated in the file you imported, on the date it was stated. It is not a live balance. "Unknown" means the file carried no balance, not zero.',
  },
  coverage: {
    title: 'What this covers',
    text: 'Only the transactions you have imported. If a statement is missing, so is its activity; nothing here is a promise that the history is complete.',
  },
  regular: {
    title: 'Regular charges',
    text: 'Charges from the same place, on the same account, that repeat about weekly, fortnightly or monthly at least three times. Upcoming dates are estimates from that pattern.',
  },
  not_classified: {
    title: 'Not yet classified',
    text: 'Rows the rules could not place: loan or mortgage repayments, cash movements, unlabelled rows and credits that are not income. They are left out of spending; labelling a row in Transactions moves it.',
  },
};
