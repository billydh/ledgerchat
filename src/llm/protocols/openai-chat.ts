import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { AdapterOptions, LlmBackend } from '../backend.js';
import { stripUnsupportedConstraints } from './schema.js';
import type { ToolCall, Turn } from '../types.js';

/** Malformed arguments belong to the caller's validation/retry loop. */
function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stopReason(reason: string | null | undefined): Turn['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

export function createOpenAIChat(
  options: AdapterOptions,
  client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    // A loopback model server must not redirect a request containing ledger data.
    fetchOptions: { redirect: 'error' },
  }),
): LlmBackend {
  const wireArguments = new WeakMap<ToolCall, string>();
  function toolCall(id: string, name: string, input: unknown): ToolCall {
    const call = { id, name, rawInput: parseInput(input) };
    if (typeof input === 'string') wireArguments.set(call, input);
    return call;
  }
  return {
    label: options.label,
    capabilities: options.capabilities,
    async complete(req) {
      const started = performance.now();
      const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];
      for (const message of req.messages) {
        if (message.role === 'user') messages.push({ role: 'user', content: message.text });
        else if (message.role === 'assistant')
          messages.push({
            role: 'assistant',
            content: message.text || null,
            ...(message.toolCalls.length
              ? {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function' as const,
                    function: {
                      name: call.name,
                      arguments: wireArguments.get(call) ?? JSON.stringify(call.rawInput) ?? 'null',
                    },
                  })),
                }
              : {}),
          });
        else
          for (const result of message.results)
            messages.push({
              role: 'tool',
              tool_call_id: result.callId,
              content: result.isError
                ? JSON.stringify({ isError: true, content: result.content })
                : result.content,
            });
      }
      const body: ChatCompletionCreateParamsBase = {
        model: options.model,
        messages,
        // Compatibility endpoints implement max_tokens, not max_completion_tokens.
        max_tokens: req.maxTokens,
        // Hybrid reasoning models (Qwen3 on oMLX/vLLM/Ollama) think by default
        // and spend the whole max_tokens budget on it. The chat-template kwarg
        // is the OpenAI-compatible way to honour LOCAL_LLM_THINKING=false.
        ...(options.capabilities.thinking
          ? {}
          : { chat_template_kwargs: { enable_thinking: false } }),
        ...(req.tools.length
          ? {
              tools: req.tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  // Strict mode is where OpenAI applies the same keyword
                  // restrictions the Anthropic validator applies always; a
                  // permissive local server keeps the full schema.
                  parameters: options.capabilities.strictTools
                    ? stripUnsupportedConstraints(tool.jsonSchema)
                    : tool.jsonSchema,
                  ...(options.capabilities.strictTools ? { strict: true } : {}),
                },
              })),
              tool_choice:
                typeof req.toolChoice === 'object'
                  ? { type: 'function', function: { name: req.toolChoice.name } }
                  : 'auto',
            }
          : {}),
        ...(req.responseFormat
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: req.responseFormat.name,
                  schema: stripUnsupportedConstraints(req.responseFormat.jsonSchema),
                  strict: true,
                },
              },
            }
          : {}),
      };
      const requestOptions = req.signal ? { signal: req.signal } : {};
      const turn: Turn = {
        text: '',
        toolCalls: [],
        stopReason: 'other',
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 0,
      };
      const prefix = `call_${randomUUID().replaceAll('-', '')}`;
      if (req.onText && options.capabilities.streaming) {
        const stream = await client.chat.completions.create(
          { ...body, stream: true, stream_options: { include_usage: true } },
          requestOptions,
        );
        const calls = new Map<number, { id: string; name: string; input: unknown }>();
        for await (const chunk of stream) {
          if (chunk.usage)
            turn.usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          const choice = chunk.choices.find((c) => c.index === 0);
          if (!choice) continue;
          if (choice.finish_reason) turn.stopReason = stopReason(choice.finish_reason);
          const text = choice.delta.content ?? choice.delta.refusal;
          if (text) {
            turn.text += text;
            req.onText(text);
          }
          for (const delta of choice.delta.tool_calls ?? []) {
            if (delta.type === 'custom') throw new Error('Custom tool calls are not supported');
            const call = calls.get(delta.index) ?? {
              id: `${prefix}_${delta.index}`,
              name: '',
              input: '',
            };
            if (delta.id) call.id = delta.id;
            if (delta.function?.name) call.name += delta.function.name;
            const input: unknown = delta.function?.arguments;
            if (typeof input === 'string')
              call.input = (typeof call.input === 'string' ? call.input : '') + input;
            else if (input !== undefined) call.input = input;
            calls.set(delta.index, call);
          }
        }
        turn.toolCalls = [...calls]
          .sort(([a], [b]) => a - b)
          .map(([, call]): ToolCall => toolCall(call.id, call.name, call.input));
      } else {
        const response = await client.chat.completions.create(
          { ...body, stream: false },
          requestOptions,
        );
        const choice = response.choices[0];
        if (!choice) throw new Error('LLM returned no completion choices');
        turn.text = choice.message.content ?? choice.message.refusal ?? '';
        turn.stopReason = stopReason(choice.finish_reason);
        turn.usage = {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        };
        turn.toolCalls = (choice.message.tool_calls ?? []).map((call, index) => {
          if (call.type === 'custom') throw new Error('Custom tool calls are not supported');
          return toolCall(
            call.id || `${prefix}_${index}`,
            call.function.name,
            call.function.arguments,
          );
        });
        if (turn.text) req.onText?.(turn.text);
      }
      req.signal?.throwIfAborted();
      turn.latencyMs = performance.now() - started;
      return turn;
    },
  };
}
