import type { Db } from '../db/client.js';
import type { LlmBackend } from '../llm/backend.js';
import {
  DEFAULT_MAX_TOKENS,
  type ChatMessage,
  type ToolCall,
  type ToolResult,
  type Usage,
} from '../llm/types.js';
import { executeTool, toolDefs } from '../tools/registry.js';
import { asksForSpendingComparison, renderSpendingComparison } from './comparison.js';
import { unevidencedFigures } from './figures.js';
import { systemPrompt } from './prompt.js';
import {
  asksForDirectBalance,
  asksForDirectCashFlow,
  renderBalances,
  renderCashFlow,
  requestedCashFlowWindow,
} from './verified-answers.js';
export { unevidencedFigures } from './figures.js';
export interface Trace {
  backendLabel: string;
  /**
   * Why a `backend_error` run stopped. The user-facing message stays generic,
   * but a failed eval question is otherwise indistinguishable from a throttled
   * one, so the provider's own wording is kept here. It is the error body, not
   * the request, so it carries no transaction data; it is capped in case a
   * provider echoes input back.
   */
  failureDetail?: string;
  turns: {
    requestSummary: { messageCount: number; toolNames: string[] };
    toolCalls: ToolCall[];
    validationErrors: string[];
    /**
     * Calls this turn that exactly repeated an earlier call in the same request
     *. Optional so earlier trace files still parse.
     */
    repeatedCalls?: RepeatedCall[];
    latencyMs: number;
    usage: Usage;
    /** The turn lacked required numerical evidence and was withheld. */
    unverified?: true;
  }[];
}
export interface RepeatedCall {
  callId: string;
  name: string;
  /** 2 for the first repeat; 3 or more ends the request unless the batch also made progress. */
  occurrence: number;
  action: 'no_progress_response' | 'terminated';
}
/**
 * Loop limits. They are part of the evaluated contract: a run recorded
 * under different limits is not comparable with one recorded under these.
 */
export const LOOP_LIMITS = Object.freeze({
  /** Model turns per request before `turn_limit`. */
  maxTurns: 8,
  /** Consecutive all-error tool batches before `tool_error_limit`. */
  maxErrorBatches: 3,
  /** Occurrences of one exact call before `repeated_call`. */
  repeatLimit: 3,
  /** Answers without required numerical evidence before `unverified_answer`. */
  unverifiedLimit: 2,
});
export type TerminationReason =
  | 'answered'
  | 'max_tokens'
  | 'stop_other'
  | 'no_tool_call'
  | 'unverified_answer'
  | 'tool_error_limit'
  | 'turn_limit'
  | 'repeated_call'
  | 'cancelled'
  | 'backend_error';
export type ChatEvent =
  | { type: 'text'; text: string }
  /** The streamed answer was withheld and the model is being asked again. */
  | {
      type: 'retry';
      reason: 'unverified_figures' | 'comparison_needs_tool' | 'direct_answer_needs_tool';
    }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'error'; error: string }
  | { type: 'done'; text: string; trace: Trace; failed: boolean };
/**
 * Exact-call detection: a signature is the tool name plus its
 * arguments with object keys sorted at every level, so key order and call ID
 * do not matter but any changed value (a different cursor, a different
 * filter) does. Malformed input is stringified the same deterministic way.
 * This catches a model re-issuing an unchanged request; it is not a semantic
 * loop detector and does not notice alternating distinct calls.
 */
export function toolCallSignature(name: string, rawInput: unknown): string {
  return `${name}\n${canonical(rawInput)}`;
}
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return typeof value;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
const EVIDENCE_NUDGE =
  'Your answer quoted a money amount or percentage absent from the successful tool results in this request, or described a percentage change in the wrong direction. Read the relevant data with a tool now and quote only its money or percentage fields with the correct direction. Do not calculate or invent figures. If the tool returns no such figure, explain that without stating an amount.';
export const UNVERIFIED_ANSWER_MESSAGE =
  "The model made a numerical claim unsupported by this request's tool results, so the answer was withheld. Try naming the period, category or merchant you mean.";
const COMPARISON_NUDGE =
  'This is a spending comparison. Call get_spending_summary once with both the primary and compare window, including the requested filters. The application will render the dated totals and change. Do not answer from separate totals or calculate the difference yourself.';
const COMPARISON_UNVERIFIED_MESSAGE =
  'The model did not provide one verifiable spending comparison, so the answer was withheld. Try naming both periods and the category or merchant.';
const DIRECT_ANSWER_UNVERIFIED_MESSAGE =
  'The model did not provide the matching account or cash-flow result, so the numerical answer was withheld. Try naming the account and period.';
export interface ConversationOptions {
  backend: LlmBackend;
  db: Db;
  messages: ChatMessage[];
  onEvent?: (event: ChatEvent) => void;
  signal?: AbortSignal;
  now?: Date;
}
export async function runConversation({
  backend,
  db,
  messages: initial,
  onEvent = () => {},
  signal,
  now = new Date(),
}: ConversationOptions) {
  const messages = [...initial],
    trace: Trace = { backendLabel: backend.label, turns: [] },
    tools = toolDefs();
  let errorBatches = 0,
    unverified = 0;
  const record: string[] = [];
  const question = [...initial].reverse().find((message) => message.role === 'user');
  const comparisonWanted = question?.role === 'user' && asksForSpendingComparison(question.text);
  const balanceWanted = question?.role === 'user' && asksForDirectBalance(question.text);
  const cashFlowWanted = question?.role === 'user' && asksForDirectCashFlow(question.text);
  // Signature state lives for this request only, so the same question asked
  // again later in the conversation is executed afresh.
  const seen = new Map<string, { occurrences: number; result: ToolResult; turn: number }>();
  const finish = (text: string, failed: boolean, reason: TerminationReason) => {
    if (failed) onEvent({ type: 'error', error: text });
    onEvent({ type: 'done', text, trace, failed });
    return { text, trace, failed, reason, messages };
  };
  if (cashFlowWanted && question?.role === 'user' && !requestedCashFlowWindow(question.text, now))
    return finish(
      'Please specify a cash-flow period I can verify: last month, this month, last 30 days, year to date, a month and year, or two YYYY-MM-DD dates.',
      false,
      'answered',
    );
  try {
    for (let i = 0; i < LOOP_LIMITS.maxTurns; i++) {
      signal?.throwIfAborted();
      const started = performance.now();
      const requestSummary = { messageCount: messages.length, toolNames: tools.map((t) => t.name) };
      const turn = await backend.complete({
        system: systemPrompt(now),
        messages,
        tools,
        maxTokens: backend.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(signal ? { signal } : {}),
        // Keep the wire stream responsive, but do not show unverified text.
        // The complete turn is emitted only after its figures pass the gate.
        onText: () => {
          signal?.throwIfAborted();
        },
      });
      signal?.throwIfAborted();
      const entry: Trace['turns'][number] & { repeatedCalls: RepeatedCall[] } = {
        requestSummary,
        toolCalls: turn.toolCalls,
        validationErrors: [],
        repeatedCalls: [],
        latencyMs: performance.now() - started,
        usage: turn.usage,
      };
      trace.turns.push(entry);
      // Preserve the exact returned array: adapters key signed thinking state by identity.
      messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });
      if (turn.stopReason === 'end' && comparisonWanted) {
        entry.unverified = true;
        if (++unverified >= LOOP_LIMITS.unverifiedLimit)
          return finish(COMPARISON_UNVERIFIED_MESSAGE, true, 'unverified_answer');
        messages.push({ role: 'user', text: COMPARISON_NUDGE });
        onEvent({ type: 'retry', reason: 'comparison_needs_tool' });
        continue;
      }
      if (turn.stopReason === 'end' && (balanceWanted || cashFlowWanted)) {
        entry.unverified = true;
        if (++unverified >= LOOP_LIMITS.unverifiedLimit)
          return finish(DIRECT_ANSWER_UNVERIFIED_MESSAGE, true, 'unverified_answer');
        messages.push({
          role: 'user',
          text: balanceWanted
            ? 'Call list_accounts so the application can render each balance with its account and as-of date.'
            : 'Call get_cash_flow for the requested period and account. The application will render each metric from that result.',
        });
        onEvent({ type: 'retry', reason: 'direct_answer_needs_tool' });
        continue;
      }
      if (turn.stopReason === 'end' && unevidencedFigures(turn.text, record).length > 0) {
        entry.unverified = true;
        if (++unverified >= LOOP_LIMITS.unverifiedLimit)
          return finish(UNVERIFIED_ANSWER_MESSAGE, true, 'unverified_answer');
        messages.push({ role: 'user', text: EVIDENCE_NUDGE });
        onEvent({ type: 'retry', reason: 'unverified_figures' });
        continue;
      }
      if (turn.stopReason !== 'tool_calls') {
        if (turn.stopReason === 'end' && turn.text) onEvent({ type: 'text', text: turn.text });
        return finish(
          turn.text,
          turn.stopReason === 'max_tokens' || turn.stopReason === 'other',
          turn.stopReason === 'max_tokens'
            ? 'max_tokens'
            : turn.stopReason === 'other'
              ? 'stop_other'
              : 'answered',
        );
      }
      if (!turn.toolCalls.length)
        return finish(
          'The model requested tools without supplying a tool call. Please try again.',
          true,
          'no_tool_call',
        );
      const results: ToolResult[] = [];
      // The request ends when a call reaches its third occurrence and the batch
      // brought nothing new; a batch that also carries a fresh call is progress.
      let exhausted = false,
        progressed = false;
      for (const call of turn.toolCalls) {
        signal?.throwIfAborted();
        onEvent({ type: 'tool_call', call });
        const signature = toolCallSignature(call.name, call.rawInput);
        const previous = seen.get(signature);
        let result: ToolResult;
        if (previous === undefined) {
          progressed = true;
          result = {
            callId: call.id,
            ...executeTool(db, call.name, call.rawInput, { now }),
          };
          if (!result.isError) record.push(result.content);
          seen.set(signature, { occurrences: 1, result, turn: i + 1 });
        } else {
          // Every call still gets exactly one result under its own ID, so the
          // transcript stays protocol-valid; the unchanged query is not re-run.
          previous.occurrences++;
          if (previous.occurrences >= LOOP_LIMITS.repeatLimit) exhausted = true;
          entry.repeatedCalls.push({
            callId: call.id,
            name: call.name,
            occurrence: previous.occurrences,
            action: 'no_progress_response',
          });
          result = {
            callId: call.id,
            isError: true,
            content: JSON.stringify({
              error: 'no_progress',
              message: `This is an exact repeat of call ${previous.result.callId} from turn ${String(previous.turn)}, which ${previous.result.isError ? 'failed validation' : 'already returned its result'}. The query was not run again.`,
              earlier_call_id: previous.result.callId,
              earlier_outcome: previous.result.isError ? 'validation_error' : 'result',
              earlier_content: previous.result.content.slice(0, 2000),
              instruction: previous.result.isError
                ? 'Correct the arguments named in the earlier validation error, or answer with the evidence already available.'
                : 'Change the arguments (a different filter, period, page cursor or tool), or answer using the result already returned.',
            }),
          };
        }
        if (result.isError) entry.validationErrors.push(result.content);
        results.push(result);
        onEvent({ type: 'tool_result', result });
      }
      messages.push({ role: 'tool', results });
      // A simple spending comparison is rendered from the dated tool result.
      // The model never gets a chance to relabel a total as a change or swap
      // the two windows in its final prose.
      const comparisonResults = turn.toolCalls.flatMap((call, index) =>
        call.name === 'get_spending_summary' && !results[index]!.isError
          ? [{ content: results[index]!.content, input: call.rawInput }]
          : [],
      );
      if (comparisonWanted && comparisonResults.length) {
        const descriptions = db
          .prepare<[], { description_norm: string }>(
            'SELECT DISTINCT description_norm FROM transactions',
          )
          .all()
          .map((row) => row.description_norm);
        const accounts = db
          .prepare<[], { id: number; name: string }>('SELECT id, name FROM accounts')
          .all();
        for (const candidate of comparisonResults) {
          const input = candidate.input;
          const groupBy =
            input && typeof input === 'object' && 'group_by' in input
              ? String(input.group_by)
              : undefined;
          const rendered = renderSpendingComparison(question.text, candidate.content, {
            descriptions,
            accounts,
            now,
            ...(groupBy ? { groupBy } : {}),
          });
          if (rendered) {
            messages.push({ role: 'assistant', text: rendered, toolCalls: [] });
            onEvent({ type: 'text', text: rendered });
            return finish(rendered, false, 'answered');
          }
        }
      }
      if (balanceWanted || cashFlowWanted) {
        const accounts = cashFlowWanted
          ? db.prepare<[], { id: number; name: string }>('SELECT id, name FROM accounts').all()
          : [];
        for (const [index, call] of turn.toolCalls.entries()) {
          if (results[index]!.isError) continue;
          const rendered =
            balanceWanted && call.name === 'list_accounts'
              ? renderBalances(question.text, results[index]!.content)
              : cashFlowWanted && call.name === 'get_cash_flow'
                ? renderCashFlow(question.text, results[index]!.content, { now, accounts })
                : null;
          if (rendered) {
            messages.push({ role: 'assistant', text: rendered, toolCalls: [] });
            onEvent({ type: 'text', text: rendered });
            return finish(rendered, false, 'answered');
          }
        }
      }
      if (exhausted && !progressed) {
        for (const repeated of entry.repeatedCalls)
          if (repeated.occurrence >= LOOP_LIMITS.repeatLimit) repeated.action = 'terminated';
        return finish(
          'The model repeated the same tool request three times without changing it, so the request was stopped. Try rephrasing or narrowing your question.',
          true,
          'repeated_call',
        );
      }
      errorBatches = results.every((r) => r.isError) ? errorBatches + 1 : 0;
      if (errorBatches >= LOOP_LIMITS.maxErrorBatches)
        return finish(
          'The model could not make a valid tool request after three attempts. Please rephrase your question.',
          true,
          'tool_error_limit',
        );
    }
    return finish(
      'The model reached the eight-turn limit. Please ask a narrower question.',
      true,
      'turn_limit',
    );
  } catch (error) {
    if (!signal?.aborted)
      trace.failureDetail = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    return finish(
      signal?.aborted
        ? 'The request was cancelled.'
        : 'The model request failed. Check the selected backend and try again.',
      true,
      signal?.aborted ? 'cancelled' : 'backend_error',
    );
  }
}
