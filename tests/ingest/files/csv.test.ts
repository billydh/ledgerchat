import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CsvParseError,
  detectDelimiter,
  detectHeader,
  parseCsv,
  readCsv,
} from '../../../src/ingest/files/csv.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../fixtures/files/${name}`, import.meta.url), 'utf8');

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes and embedded newlines', () => {
    const rows = parseCsv('a,"b ""quoted"" c","line\none"\n1,2,3\n', ',');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b "quoted" c', 'line\none'] },
      { line: 3, cells: ['1', '2', '3'] },
    ]);
  });

  it('strips a BOM and accepts CRLF and bare CR line endings', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r3,4', ',')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
      { line: 3, cells: ['3', '4'] },
    ]);
  });

  it('drops blank rows and keeps a stray quote inside an unquoted field', () => {
    const rows = parseCsv('a,b\n\n  ,  \nx 12" y,z\n', ',');
    expect(rows.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['x 12" y', 'z'],
    ]);
  });

  it('rejects an unterminated quoted field with the line it started on', () => {
    expect(() => parseCsv('a,b\n1,"open\n2,3', ',')).toThrow(CsvParseError);
    expect(() => parseCsv('a,b\n1,"open\n2,3', ',')).toThrow('line 2');
  });
});

describe('detectDelimiter', () => {
  it('prefers the delimiter that splits every line the same way', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2,5;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
  });

  it('ignores delimiters inside quotes', () => {
    expect(detectDelimiter('a;b\n"1,2";3\n"4,5";6\n')).toBe(';');
  });
});

describe('detectHeader', () => {
  it('sees a header when row one has no data-like cells and row two does', () => {
    expect(detectHeader(parseCsv('Date,Description,Amount\n2026-01-01,x,-1.00\n', ','))).toBe(true);
    expect(detectHeader(parseCsv('01/02/2026,x,-1.00\n02/02/2026,y,-2.00\n', ','))).toBe(false);
    expect(detectHeader(parseCsv('Date,Description\n', ','))).toBe(false);
  });
});

describe('readCsv', () => {
  it('names columns from the header and excludes it from the rows', () => {
    const table = readCsv(fixture('signed-header.csv'));
    expect(table).toMatchObject({ delimiter: ',', hasHeader: true });
    expect(table.columns).toEqual(['Date', 'Description', 'Amount', 'Balance']);
    expect(table.rows).toHaveLength(7);
    expect(table.rows[0]).toEqual({
      line: 2,
      cells: ['2026-08-01', 'WOOLWORTHS 3120 RICHMOND', '-84.20', '1523.45'],
    });
  });

  it('numbers the columns of a headerless file', () => {
    const table = readCsv(fixture('no-header-dmy.csv'));
    expect(table.hasHeader).toBe(false);
    expect(table.columns).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(table.rows).toHaveLength(4);
  });

  it('reads a BOM-prefixed, semicolon-delimited file', () => {
    const table = readCsv(fixture('semicolon-mdy.csv'));
    expect(table.delimiter).toBe(';');
    expect(table.columns[0]).toBe('Posted Date');
  });

  it('honours explicit delimiter and header options', () => {
    const table = readCsv('a;b\n1;2\n', { delimiter: ';', hasHeader: false });
    expect(table.columns).toEqual(['Column 1', 'Column 2']);
    expect(table.rows).toHaveLength(2);
  });
});
