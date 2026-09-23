import { z } from 'zod';
import type { LlmBackend } from './backend.js';
import { DEFAULT_MAX_TOKENS, type ChatMessage, type Turn, type Usage } from './types.js';

export type StructuredOutputMode = 'native' | 'forced_tool';
export interface StructuredOutput<T> {
  value: T;
  mode: StructuredOutputMode;
  /** Total backend calls, including a rejected native request. */
  attempts: number;
  usage: Usage;
}

export class StructuredOutputError extends Error {
  constructor(
    readonly lastRawOutput: unknown,
    readonly lastValidationError: Error,
    readonly mode: StructuredOutputMode,
    readonly attempts: number,
    readonly usage: Usage,
  ) {
    super('Structured output failed after three invalid responses', { cause: lastValidationError });
    this.name = 'StructuredOutputError';
  }
}

/** Extract one complete JSON value, allowing fences or tool-call text around it. */
function parseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Scan balanced containers without treating braces inside strings as delimiters.
    const start = text.search(/[[{]/);
    if (start < 0) throw new Error('Expected JSON output or a submit tool call');
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        stack.pop();
        if (stack.length === 0) return JSON.parse(text.slice(start, i + 1)) as unknown;
      }
    }
    throw new Error('Incomplete JSON output');
  }
}

function unwrapTool(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if ('name' in value && value.name === 'submit') {
    const input = 'arguments' in value ? value.arguments : 'input' in value ? value.input : value;
    return typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  }
  if ('function' in value) return unwrapTool(value.function);
  return value;
}

function output(turn: Turn, mode: StructuredOutputMode): unknown {
  if (turn.stopReason === 'max_tokens')
    throw new Error('Output was truncated; return a complete result');
  if (mode === 'forced_tool' && turn.toolCalls.length) {
    const call = turn.toolCalls[0];
    if (turn.toolCalls.length !== 1 || call?.name !== 'submit') {
      throw new Error('Expected exactly one submit tool call');
    }
    return call.rawInput;
  }
  if (turn.toolCalls.length) throw new Error('Expected native JSON, not tool calls');
  const value = parseText(turn.text);
  return mode === 'forced_tool' ? unwrapTool(value) : value;
}

export async function generateStructured<T>(
  backend: LlmBackend,
  schema: z.ZodType<T>,
  prompt: string,
): Promise<StructuredOutput<T>> {
  const jsonSchema = z.toJSONSchema(schema);
  const messages: ChatMessage[] = [{ role: 'user', text: prompt }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let mode: StructuredOutputMode = backend.capabilities.nativeStructuredOutput
    ? 'native'
    : 'forced_tool';
  let attempts = 0;
  let invalid = 0;
  while (true) {
    let turn: Turn;
    attempts++;
    try {
      turn = await backend.complete({
        system:
          'Return the requested structured data. Use exactly one submit call when a tool is provided; otherwise return JSON.',
        messages: [...messages],
        tools:
          mode === 'native'
            ? []
            : [{ name: 'submit', description: 'Submit the structured result.', jsonSchema }],
        ...(mode === 'native'
          ? { responseFormat: { name: 'result', jsonSchema } }
          : backend.capabilities.forcedToolChoice
            ? { toolChoice: { name: 'submit' } }
            : {}),
        maxTokens: backend.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
    } catch (error) {
      if (
        mode === 'native' &&
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500
      ) {
        mode = 'forced_tool';
        continue;
      }
      throw error;
    }
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    let raw: unknown = turn.toolCalls.length ? turn.toolCalls : turn.text;
    try {
      raw = output(turn, mode);
      return { value: schema.parse(raw), mode, attempts, usage };
    } catch (error) {
      const validation = error instanceof Error ? error : new Error(String(error));
      if (++invalid === 3) throw new StructuredOutputError(raw, validation, mode, attempts, usage);
      // Keep the exact array for the adapters' private thinking/replay state.
      messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });
      const correction = `Correct the result and submit it again. Validation error: ${validation.message}`;
      if (turn.toolCalls.length) {
        messages.push({
          role: 'tool',
          results: turn.toolCalls.map((call) => ({
            callId: call.id,
            content: correction,
            isError: true,
          })),
        });
      } else {
        messages.push({ role: 'user', text: correction });
      }
    }
  }
}
