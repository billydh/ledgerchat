/**
 * A dependency-free RFC 4180 reader. Bank exports are small, so the whole
 * file is read into memory and returned as rows of cells; the mapping layer
 * (`detect.ts`) decides what the cells mean.
 *
 * Handles quoted fields, doubled quotes, embedded newlines, a UTF-8 BOM, CRLF
 * and bare CR line endings, and the three delimiters banks actually use. Rows
 * that are entirely blank are dropped; ragged rows are kept and reported so a
 * caller can decide whether they matter.
 */

export type Delimiter = ',' | ';' | '\t';

export interface CsvRow {
  /** 1-based line number of the row's first line in the file, for error messages. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  delimiter: Delimiter;
  hasHeader: boolean;
  /** Header names when present, else `Column 1`, `Column 2`, ... */
  columns: string[];
  /** Data rows only; the header row is not among them. */
  rows: CsvRow[];
}

const DELIMITERS: readonly Delimiter[] = [',', ';', '\t'];

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${String(line)}: ${message}`);
    this.name = 'CsvParseError';
  }
}

/** Splits the text into rows of raw cells. Quoted cells may span lines. */
export function parseCsv(text: string, delimiter: Delimiter): CsvRow[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let line = 1;
  let rowLine = 1;
  let quoted = false;
  let cellStarted = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    if (cells.some((value) => value.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      // A quote opens a quoted field only at the start of a cell; a stray
      // quote inside an unquoted description is kept as a literal character.
      quoted = true;
      cellStarted = true;
      cell = '';
      continue;
    }
    if (ch === delimiter) {
      endCell();
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
      continue;
    }
    cell += ch;
    cellStarted = true;
  }
  if (quoted) throw new CsvParseError('unterminated quoted field', rowLine);
  if (cellStarted || cells.length) endRow();
  return rows;
}

/**
 * Picks the delimiter that splits the first lines into the most consistent
 * number of columns greater than one. Quoted regions are ignored while
 * counting, so a comma inside a quoted description does not vote.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 20);
  let best: { delimiter: Delimiter; score: number } = { delimiter: ',', score: -1 };
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, delimiter));
    if (!counts.length || counts[0] === 0) continue;
    const mode = modeOf(counts);
    if (mode === 0) continue;
    const consistent = counts.filter((n) => n === mode).length / counts.length;
    const score = consistent * 1000 + mode;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) count++;
  }
  return count;
}

function modeOf(values: number[]): number {
  const tally = new Map<number, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  let mode = 0;
  let modeCount = -1;
  for (const [value, count] of tally) {
    if (count > modeCount || (count === modeCount && value > mode)) {
      mode = value;
      modeCount = count;
    }
  }
  return mode;
}

const NUMERIC_CELL = /^[\s($+-]*(?:[A-Z]{1,3}\$?|\$)?\s*[($+-]*[\d.,]+\s*\)?\s*(?:CR|DR)?\s*$/i;
const DATE_CELL = /^\s*(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}[ -][A-Za-z]{3,9}[ -]\d{2,4})/;

/**
 * Row one is a header when none of its cells looks like a number or a date and
 * the next row has at least one cell that does. A file with a single row is
 * treated as headerless: there is nothing to compare it with.
 */
export function detectHeader(rows: readonly CsvRow[]): boolean {
  const [first, second] = rows;
  if (!first || !second) return false;
  const looksLikeData = (cell: string) => NUMERIC_CELL.test(cell) || DATE_CELL.test(cell);
  if (first.cells.some((cell) => cell.trim() !== '' && looksLikeData(cell))) return false;
  return second.cells.some(looksLikeData);
}

export interface ReadCsvOptions {
  delimiter?: Delimiter;
  hasHeader?: boolean;
}

/** Parses the file and names its columns. Throws `CsvParseError` on malformed quoting. */
export function readCsv(text: string, options: ReadCsvOptions = {}): CsvTable {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const hasHeader = options.hasHeader ?? detectHeader(rows);
  const width = Math.max(0, ...rows.map((row) => row.cells.length));
  const headerCells = hasHeader ? (rows[0]?.cells ?? []) : [];
  const columns = Array.from({ length: width }, (_, i) => {
    const name = headerCells[i]?.trim();
    return name ? name : `Column ${String(i + 1)}`;
  });
  return { delimiter, hasHeader, columns, rows: hasHeader ? rows.slice(1) : rows };
}
