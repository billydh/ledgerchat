import type { JsonSchema } from '../types.js';

/**
 * Anthropic's tool and structured-output validators reject the numeric range
 * keywords outright, and OpenAI rejects them under `strict: true`. Zod emits
 * them for any `.min()`, `.max()`, `.positive()`, `.int()` or `.multipleOf()`,
 * so a schema that a permissive local server accepts fails on a strict
 * endpoint with `invalid_request_error` before inference starts.
 *
 * Verified against `claude-haiku-4-5` on 2026-09-11: `minimum`, `maximum`,
 * `exclusiveMinimum`, `exclusiveMaximum` and `multipleOf` are refused on both
 * `number` and `integer`, and `maxItems` and `uniqueItems` are refused on
 * `array`. `minItems`, every string keyword (`minLength`, `maxLength`,
 * `pattern`, `format`), `enum`, `const`, `default`, `description`, `anyOf` and
 * `$schema` are all accepted.
 *
 * Dropping a bound silently would leave the model free to pass an out of range
 * value and spend a turn on the validation error it gets back, so each stripped
 * bound is appended to that property's description instead. Nothing about
 * validation changes: the Zod schema still rejects the value at execution.
 */
const phrases: Record<string, (value: unknown) => string | undefined> = {
  minimum: (value) => (representational(value) ? undefined : `>= ${String(value)}`),
  maximum: (value) => (representational(value) ? undefined : `<= ${String(value)}`),
  exclusiveMinimum: (value) => (representational(value) ? undefined : `> ${String(value)}`),
  exclusiveMaximum: (value) => (representational(value) ? undefined : `< ${String(value)}`),
  multipleOf: (value) => `a multiple of ${String(value)}`,
  maxItems: (value) => `at most ${String(value)} items`,
  uniqueItems: (value) => (value === true ? 'unique items' : undefined),
};

/**
 * `z.number().int()` pins the JavaScript safe-integer range, which describes the
 * encoding rather than the tool, so it is dropped without a note. A real bound
 * that happens to sit on the boundary loses only its description line.
 */
function representational(value: unknown): boolean {
  return value === Number.MAX_SAFE_INTEGER || value === Number.MIN_SAFE_INTEGER;
}

const schemaMaps = ['properties', 'patternProperties', '$defs', 'definitions'];
const schemaLists = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const schemaValues = ['items', 'additionalProperties', 'contains', 'not', 'propertyNames'];

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a copy with the unsupported keywords removed at every depth. */
export function stripUnsupportedConstraints(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key in phrases) {
      const note = phrases[key]!(value);
      if (note) notes.push(note);
      continue;
    }
    if (schemaMaps.includes(key) && isSchema(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          isSchema(child) ? stripUnsupportedConstraints(child) : child,
        ]),
      );
    else if (schemaLists.includes(key) && Array.isArray(value))
      out[key] = (value as unknown[]).map((child: unknown) =>
        isSchema(child) ? stripUnsupportedConstraints(child) : child,
      );
    else if (schemaValues.includes(key) && isSchema(value))
      out[key] = stripUnsupportedConstraints(value);
    else out[key] = value;
  }
  if (notes.length) {
    const existing = typeof out.description === 'string' ? `${out.description} ` : '';
    out.description = `${existing}Constraints: ${notes.join(', ')}.`;
  }
  return out;
}
