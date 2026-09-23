# Numerical answer validation — 23 September 2026

This report records checks for Ledgerchat's application-rendered spending comparisons, direct account balances, and direct cash-flow answers. It describes the current implementation at this date. All recorded evaluations used synthetic data in an in-memory database; no personal banking data was sent to a model.

Code under test: `e7ed0cf`.

## Reproduce the checks

From the repository root:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec tsx scripts/eval-spending-comparisons.ts --audit-only
```

The test suite and adversarial audit do not require a model. For optional live checks, start a local tool-calling model and run:

```sh
pnpm exec tsx scripts/eval-spending-comparisons.ts
pnpm exec tsx scripts/eval-direct-answers.ts
```

The live scripts default to `local/Qwen3.8-27B-4bit` at `http://127.0.0.1:8000`; `CHAT_LIVE_BACKEND` and `LOCAL_LLM_BASE_URL` can override these settings. They fix the application date at 23 September 2026 and print the question, tool calls, answer, and result as JSON lines. The comparison script seeds synthetic transactions; the direct-answer script also seeds an imported balance. The comparison script accepts `--cases=6,7,9` to run selected cases.

## Recorded results

| Check                        |                Result |
| ---------------------------- | --------------------: |
| Repository tests             | 443 passed, 1 skipped |
| Typecheck, lint, build       |                Passed |
| Adversarial comparison audit |          13/13 passed |
| Comparison routing checks    |            3/3 passed |
| Selected local-model checks  |                Passed |

The skipped test is the existing opt-in live-backend test. The adversarial audit covers wrong category, merchant, account, transfer, and date scope; missing merchant grouping; and a matching result. Routing checks cover expense wording, a comparison with top merchants, and a comparison with a separate transaction-list request.

In the recorded live runs, a top-merchants comparison used one grouped call. A yearless July/August comparison passed after the model corrected an invalid first call. Direct balance and cash-flow questions each passed in one call.

The live checks used the local `Qwen3.8-27B-4bit` model with thinking disabled. The comparison script contains 14 synthetic questions covering full and partial months, categories, a named merchant and account, transfer scope, relative months, and top merchants. The direct-answer script contains two questions. The recorded selected runs are examples of behavior on this backend, not a measured success rate across models or datasets.

## What the guards check

For a straightforward spending comparison, Ledgerchat renders amounts and direction from one successful `get_spending_summary` result. Before rendering, it checks the requested category or subcategory, named description, account or card, transfer setting, and date windows against the result. It validates change arithmetic. A request that also asks for top merchants requires merchant grouping, reconciles grouped amounts to the comparison totals, and labels the ranked values as transaction descriptions.

Direct balance answers come from `list_accounts`, with each amount attached to its account and imported as-of date. Direct cash-flow answers come from `get_cash_flow`, with the requested window and account or transfer scope checked before incoming credits, outgoing debits, and net flow are rendered. The net amount is checked against incoming minus outgoing.

If imported transactions do not overlap a requested comparison or cash-flow window, the answer says the result is unavailable. It does not present that missing period as zero spending or cash flow. Yearless month names in comparisons resolve to their most recent occurrence relative to the application date; the current month ends today.

## Limits

- The 13 adversarial cases are hand-picked regression checks. They do not establish a reliability percentage or cover every phrasing and follow-up question.
- The live scorer checks expected text fragments and a non-failed result. It does not prove that every part of an answer is correct. Model choice, configuration, and data can change behavior.
- Other freeform numerical answers have a narrower check that confirms quoted values appear in tool results; it cannot always prove that a value was attached to the right period, merchant, account, or metric.
- Merchant grouping uses normalized transaction descriptions, which may not correspond one-to-one with merchant identities. Named-description matching may miss aliases or unfamiliar wording.
- Transaction extent shows where imported rows exist, not whether imported history is complete within that range. The application does not treat overlap as proof of complete coverage.
