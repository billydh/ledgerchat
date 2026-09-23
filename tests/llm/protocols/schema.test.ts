import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stripUnsupportedConstraints } from '../../../src/llm/protocols/schema.js';
import { toolDefs } from '../../../src/tools/registry.js';
import { categorisationSchema } from '../../../src/ingest/categorise.js';

/** The exact keywords the Anthropic validator refuses, at any depth. */
const refused = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
];
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]);
}

describe('stripUnsupportedConstraints', () => {
  it('removes a bound and records it in the property description', () => {
    expect(
      stripUnsupportedConstraints({
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 20, description: 'Constraints: >= 1, <= 100.' },
      },
      additionalProperties: false,
    });
  });

  it('keeps an existing description and appends to it', () => {
    expect(
      stripUnsupportedConstraints({
        type: 'number',
        description: 'Score.',
        minimum: 0,
        maximum: 1,
      }),
    ).toEqual({ type: 'number', description: 'Score. Constraints: >= 0, <= 1.' });
  });

  it('drops the JavaScript safe-integer bound without a description line', () => {
    expect(
      stripUnsupportedConstraints({
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ type: 'integer', description: 'Constraints: > 0.' });
  });

  it('keeps every supported keyword, including minItems and string constraints', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1, maxLength: 500, pattern: '^a', format: 'date' },
    };
    expect(stripUnsupportedConstraints(schema)).toEqual(schema);
  });

  it('recurses through items, anyOf and $defs', () => {
    const stripped = stripUnsupportedConstraints({
      $defs: { n: { type: 'integer', minimum: 1 } },
      anyOf: [
        { type: 'array', items: { type: 'integer', maximum: 5 } },
        { type: 'object', properties: { p: { type: 'number', multipleOf: 2 } } },
      ],
    });
    expect(keys(stripped).filter((key) => refused.includes(key))).toEqual([]);
    expect(JSON.stringify(stripped)).toContain('Constraints: a multiple of 2.');
  });

  it('leaves a schema without any refused keyword untouched', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean', const: true } } };
    expect(stripUnsupportedConstraints(schema)).toEqual(schema);
  });

  it('clears every refused keyword from the shipped tool and categorisation schemas', () => {
    const schemas = [
      ...toolDefs().map((tool) => tool.jsonSchema),
      z.toJSONSchema(categorisationSchema),
    ];
    expect(schemas.some((schema) => keys(schema).some((key) => refused.includes(key)))).toBe(true);
    for (const schema of schemas)
      expect(
        keys(stripUnsupportedConstraints(schema)).filter((key) => refused.includes(key)),
      ).toEqual([]);
  });
});
