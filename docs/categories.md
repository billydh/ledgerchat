# Categories

Every distinct normalised description is labelled once by the model
(`pnpm categorise`, or **Categorise now** after an import) and the label is
copied onto every transaction with that description. Labels are two levels. The model picks one **subcategory** (a leaf) per distinct
description; the **category** (its parent) is derived in code from a single mapping
in `src/ingest/taxonomy.ts` and is never stored, so the two can never disagree.
13 parents cover 38 subcategories:

| Category              | Subcategories                                                                     |
| --------------------- | --------------------------------------------------------------------------------- |
| `food_drink`          | `groceries`, `dining`, `food_drink_other`                                         |
| `transport`           | `public_transport`, `fuel`, `vehicle_maintenance`, `transport_other`              |
| `housing`             | `rent`, `mortgage`, `home_maintenance`, `utilities`, `housing_other`              |
| `insurance`           | `insurance_premiums`                                                              |
| `health_wellbeing`    | `health`, `fitness`, `personal_care`, `health_wellbeing_other`                    |
| `lifestyle`           | `entertainment`, `shopping`, `travel`, `lifestyle_other`                          |
| `education`           | `tuition_courses`                                                                 |
| `giving`              | `gifts`, `donations`, `giving_other`                                              |
| `income`              | `income_salary`, `income_benefits`, `income_other`                                |
| `financial_costs`     | `bank_fees`, `interest_charged`, `tax`, `loan_repayment`, `financial_costs_other` |
| `savings_investments` | `savings`, `investments`, `savings_investments_other`                             |
| `cash`                | `cash_movement`                                                                   |
| `uncategorised`       | `other`                                                                           |

No subcategory shares an identifier with a category, deliberately and without
exception: the two tool filters mean different things, so a shared name would let a
caller pass one while meaning the other and no schema would catch it. Every parent
with more than one leaf has a `<parent>_other` escape hatch for when the parent is
established but the child is not; a specific leaf always wins over it.

Three attributes are kept separate from spending purpose, because conflating them
loses information:

- `is_subscription` is a descriptive hint from the description (true, false, or
  null for unknown), not proof of payment cadence. Rent, utilities and salary are
  recurring without being subscriptions, and the recurring-payment detector does
  not read this field.
- `is_internal_transfer` comes from transfer matching and the classifier's separate
  transfer hint. A movement into your own savings account is labelled `savings`
  _and_ flagged as a transfer; neither implies the other.
- `cash_movement` records that cash moved, which is knowledge. `uncategorised`
  means classification did not succeed. They are different facts and different
  parents, so enrichment quality stays measurable.

**Tool contract.** `search_transactions` takes `category` for a
parent (which includes every subcategory beneath it) and `subcategory` for one
exact leaf; supplying both applies both, so an incompatible pair matches nothing.
There are deliberately no aliases accepting a leaf in the parent filter.
`get_spending_summary` also accepts optional `query`, `category`, `subcategory`
and `account_id` filters, intersected exactly as transaction search. Query is a
literal substring of the normalised description, including literal `%` and `_`.
Windows are flat fields: `period` for a preset (`last_month`,
`this_month`, `last_30_days`, `ytd`) or `from` and `to` as `YYYY-MM-DD` dates,
exactly one of the two, on both `get_spending_summary` and `get_cash_flow`; a `{from, to}` object or a JSON string of one is rejected with a message naming
the flat fields. Add a comparison window in the same shape,
`compare_period` or `compare_from` and `compare_to` (`compare_to` is the comparison window's end date), to
receive `comparison.totals` and `comparison.groups`, each with `primary_total`,
`comparison_total`, signed `change` (primary minus comparison), and
`percentage_change` rounded to two decimals. A zero comparison total returns a
null percentage with `percentage_change_reason: "comparison_total_zero"`.
Currencies stay separate; groups appearing in only one window use zero in the
other. Month groups keep literal calendar month keys rather than aligning months.

Existing primary result fields are preserved. `filters` echoes the resolved
filters; each window reports inclusive UTC `date_range`, `day_count`, and
`coverage` with the account-scoped stored transaction extent and its overlap
with the window. Extent is not proof of complete history. The legacy
`data_coverage` remains the database-wide extent. Unequal windows are never
normalised: `this_month` ends today and `last_month` covers the full previous
calendar month. Equivalent-day comparisons need explicit bounds.

`get_spending_summary` accepts `group_by: 'category'` for the roll-up and
`group_by: 'subcategory'` for leaf detail. A fuel search passes
`subcategory: 'fuel'`; a broad transport search passes `category: 'transport'`.
Rows also return `subcategory` and `is_subscription`.

**Reporting caveat.** A spending summary sums outgoing money, not consumption, so
`savings`, `investments`, `tax`, `loan_repayment` and `cash_movement` are included
in category totals. There is no spending-versus-movement axis yet; read a total
with that in mind.

## Correcting a label

The **Categories** button in the web UI opens a small editor: search stored
transactions (the same `search_transactions` code the model uses, including
internal transfers), select a row, choose a subcategory and apply it to that
transaction only or to every transaction from the same source with exactly the
same normalised description. The editor shows how many stored rows a description
rule would cover before it is applied, and a rule also covers rows that arrive in
later imports. Each selected row shows its current label, where it came from
(machine label, corrected for this transaction, corrected by a description rule)
and the machine label underneath, with a Remove button for each correction.

Precedence is transaction override, then description rule, then machine label.
Removing a correction restores the next one down. Corrections survive re-imports,
`pnpm categorise --recategorise` and restarts because the categoriser only writes
`machine_subcategory`; the effective `subcategory` column every tool reads is
re-resolved from the three sources. Category corrections change the label only,
never `is_subscription` or the transfer flags. Transfer decisions can be
corrected separately in Transactions; correcting an automatic pair changes
both legs, and the decision survives re-imports. The model has no tool that
writes corrections. The local API is `GET /api/categories`,
`GET /api/transactions`, `GET|PUT|DELETE /api/transactions/:id/category`, and
`PUT /api/transactions/:id/transfer`. Every request needs the local browser
password, and non-GET `/api/*` requests from another browser origin are refused.

## Running the categoriser

`pnpm categorise` labels uncached descriptions in batches of 50, asking the
model for one subcategory plus a confidence, a transfer hint and a subscription
hint per description, then matches internal transfers. It uses the configured
model; `--backend local/<model>` overrides it. `--recategorise` clears the description cache before rebuilding
it. Failed batches leave completed work persisted and exit nonzero; rerun
without `--recategorise` to resume. Check the first run's `failures` count
before trusting anything downstream: one of 38 leaves plus a subscription hint
is a harder target for a small local model than a flat list.
