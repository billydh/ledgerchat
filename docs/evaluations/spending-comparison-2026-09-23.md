# Spending comparison validation — 23 September 2026

## Scope and method

This evaluation tested the new application-rendered `get_spending_summary` comparison path. It used an in-memory database with six synthetic posted debits: July and August groceries, dining and fuel. No personal banking data was sent to the model. The live backend was the local `Qwen3.8-27B-4bit` model at `127.0.0.1:8000`, with thinking disabled and a fixed application date of 23 September 2026.

Run the evaluation with `pnpm exec tsx scripts/eval-spending-comparisons.ts`. The quick adversarial audit is `pnpm exec tsx scripts/eval-spending-comparisons.ts --audit-only`. The script prints each question, tool arguments, answer, and result as JSON lines.

## Results

| Check | Result | Observation |
| --- | ---: | --- |
| Live model questions using the comparison route | 8/8 passed | Correct amounts and direction for full months, reversed phrasing, grocery, fuel, transport, a named merchant, partial months, and higher-or-lower wording. |
| Live “expenses” synonym question | 1/1 semantically correct on manual review | The keyword router missed it. The model made two tool calls and wrote a freeform answer with the right totals and change. The original exact-string scorer flagged its different currency formatting, so that initial automated failure was a scoring false positive; the scorer now accepts either formatting. |
| Adversarial guard audit | 3/5 passed | A matching call was accepted; wrong category and wrong full month were rejected. Two incorrect calls were accepted, detailed below. |
| Full repository tests | 423 passed, 1 skipped | The skipped test is the existing opt-in live-backend test. |
| Typecheck and lint | Passed | Includes the evaluation script. |

One live fuel question initially led the model to request July–August as one window and July as the comparison. The application did not render that mismatched result; the model made a second call with separate July and August windows, and the final answer was correct. The other seven live questions used one tool call each.

The application also has targeted tests for reversed windows, incorrect category/month, inconsistent arithmetic, zero percentage baseline, separate currencies, and withholding a model answer that skips the comparison tool.

## Guard gaps found

1. **Omitted merchant filter.** For “How did my Woolworths spending change between July and August 2026?”, the guard accepted a valid comparison tool result with no `query` filter. Its amounts covered all spending, despite the question naming Woolworths. The live model supplied `query: "woolworths"` and answered correctly, but the guard did not require it.
2. **Partial dates replaced by full months.** For “from 1–15 July to 1–15 August 2026”, the guard accepted a result for the full months. The live model used the requested half-month windows, but the month-name checker deliberately does not validate explicit day ranges.
3. **Comparison wording outside the router.** “Compare my expenses in July and August 2026” did not trigger the app-rendered comparison route. The live model answered correctly through the ordinary freeform path, but that path cannot verify that each quoted amount is attached to the right period or metric. It also required two model tool calls and took about 95 seconds in this run.

These are semantic failures: schema-valid, arithmetically correct tool results can still answer a different question. The nine live questions are a small sample, not a reliability estimate or a claim that the guard proves the model chose the right query. The current comparison path is strongest for two explicitly named full months and recognised category or subcategory wording.

## Recommendation

Keep deterministic arithmetic and app-rendered numbers. Before treating the answer as verified, validate a structured query plan against the user's requested scope and exact windows, including merchants and partial dates. Then let the model select named result facts for natural-language presentation. Add these two adversarial cases as required passing checks for that change, and expand the live set with ambiguous, follow-up, no-data and multi-currency questions.

## Follow-up fix and retest

The comparison guard now compares explicit day ranges with the returned windows, including ISO dates, day-first spans and month-first spans. Ambiguous slash dates are withheld. It also checks that a named transaction description appears in the tool's literal `query` filter and rejects an unrequested query or category filter. “Expenses” now enters the comparison route.

The adversarial guard audit improved from **3/5 to 5/5**, and the routing check now passes. On the local model, the Woolworths case passed in one tool call. The partial-month case passed after the guard rejected a first call that omitted the food-and-drink category and the model corrected it. The “expenses” case passed in one call with an app-rendered answer after its expected-output scorer was updated for that format. All three affected live answers had the correct totals and direction. The full repository suite now has **426 passing tests and 1 skipped test**; typecheck, lint and build also pass.

This is still a bounded guard, not a general proof of query intent. Merchant matching uses literal words from stored descriptions plus common question phrasing; aliases and unfamiliar expressions may be withheld or missed.

## Further hardening and retest

The guard now rejects a comparison when a requested category or subcategory is omitted, an account or transfer filter differs from the request, or relative month windows do not match the application date. A supported two-part question asking for a comparison and top merchants uses one `get_spending_summary` result grouped by merchant. The application checks that grouped amounts reconcile to the comparison totals and renders both parts. Other multi-part questions continue through the model so a second requested task is not cut off.

The adversarial audit passes **11/11** cases, including wrong health scope, unrequested account and transfer filters, wrong relative months, and missing merchant grouping. The routing checks cover both supported top merchants and an unsupported transaction-list request. The local model answered the top-merchants case in one grouped comparison call in **16.6 seconds** with the correct July and August totals, AUD 643.08 increase, and ranked synthetic descriptions. The prior live checks for relative months, named account and requested transfers also passed. The full repository suite has **432 passing tests and 1 skipped test**; typecheck, lint and build pass.

The top-merchants output ranks normalized transaction descriptions, which may not correspond one-to-one with real merchant identities. The guard recognizes common category, account, merchant and date phrasing; unfamiliar wording may be withheld for correction rather than rendered as a verified comparison.

## Balance, cash-flow, date and coverage follow-up

Direct balance questions now render the account name, balance type, amount and imported as-of date from one `list_accounts` result. Direct cash-flow questions render incoming credits, outgoing debits and net flow by currency from a `get_cash_flow` result whose date, account and transfer scope matches the question. The application checks the cash-flow arithmetic and withholds freeform numerical answers when either direct route lacks its tool result. Other freeform answers still use the narrower value-evidence check; they do not yet have full fact-to-scope attribution.

Yearless named months in comparisons now resolve against the fixed application date. For example, July and August without a year resolve to July and August 2026 on 23 September 2026; a current named month ends today. Named cards are checked against imported account names. A comparison or cash-flow request with no imported transaction extent overlapping its window reports that the result is unavailable, rather than presenting the missing period as zero spending. Observed transaction extent still does not prove complete history within an overlapping window.

The expanded adversarial comparison audit passes **13/13** cases, including a named card whose account filter was omitted and yearless months mapped to the wrong year. The local model passed the yearless July/August case after correcting an initially invalid tool call. In a separate synthetic-data live run, the named card balance and last-month cash-flow questions both passed in one call each, with correct labels and amounts. The full repository suite has **443 passing tests and 1 skipped test**; typecheck, lint and build pass.
