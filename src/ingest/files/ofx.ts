/**
 * OFX 1.x (SGML, leaf tags without closing tags) and 2.x (XML) reader. QFX is
 * OFX with extra Intuit headers, which this reader ignores like any header.
 *
 * The grammar is small: after the header block, a tree of aggregates whose
 * leaves are `<TAG>value`. A leaf in 1.x has no closing tag, so the tokeniser
 * treats any tag followed by text as a leaf and any tag followed by another
 * tag as an aggregate; a 2.x closing tag for a leaf is simply skipped.
 */

export interface OfxAccount {
  /** `bankId:accountId` for a bank account, `accountId` for a card. */
  externalId: string;
  accountId: string;
  bankId?: string;
  /** The OFX account type, e.g. CHECKING, SAVINGS, CREDITCARD. */
  accountType: string;
  currency: string;
  institution?: string;
  balance?: { currentCents: number; availableCents?: number; asOf?: string };
  transactions: OfxTransaction[];
  /** Statement window, when the file states one. */
  dateStart?: string;
  dateEnd?: string;
}

export interface OfxTransaction {
  fitId: string;
  type: string;
  /** ISO-8601 UTC. */
  postedAt: string;
  userDate?: string;
  amountCents: number;
  name?: string;
  memo?: string;
  checkNumber?: string;
  raw: Record<string, string>;
}

export interface OfxDocument {
  version: '1' | '2';
  institution?: string;
  accounts: OfxAccount[];
  /** Transactions that could not be read, with the reason. Never fatal. */
  errors: { fitId: string; message: string }[];
}

export class OfxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfxParseError';
  }
}

interface Node {
  name: string;
  value?: string;
  children: Node[];
}

const TOKEN = /<(\/?)([A-Za-z0-9._-]+)>([^<]*)/g;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(\d+);/g, (entity, code?: string) =>
    code === undefined ? (ENTITIES[entity] ?? entity) : String.fromCodePoint(Number(code)),
  );
}

/** Looks like OFX at all: has the root aggregate somewhere after the headers. */
export function looksLikeOfx(text: string): boolean {
  return /<OFX>/i.test(text);
}

/** Builds the tree. Tags are matched case-insensitively and reported upper case. */
export function parseOfxTree(text: string): { version: '1' | '2'; root: Node } {
  const start = text.search(/<OFX>/i);
  if (start === -1) throw new OfxParseError('No <OFX> element found; is this an OFX or QFX file?');
  const version = /<\?xml|<\?OFX/i.test(text.slice(0, start)) ? '2' : '1';
  const root: Node = { name: 'DOCUMENT', children: [] };
  const stack: Node[] = [root];
  const body = text.slice(start);
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(body)) !== null) {
    const closing = match[1] === '/';
    const name = match[2]!.toUpperCase();
    const value = decode(match[3]!).trim();
    if (closing) {
      // Pop to the matching aggregate; a leaf's closing tag (2.x) matches nothing.
      const depth = stack.map((n) => n.name).lastIndexOf(name);
      if (depth > 0) stack.length = depth;
      continue;
    }
    const parent = stack[stack.length - 1]!;
    if (value !== '') {
      parent.children.push({ name, value, children: [] });
    } else {
      const node: Node = { name, children: [] };
      parent.children.push(node);
      stack.push(node);
    }
  }
  const ofx = root.children.find((n) => n.name === 'OFX');
  if (!ofx) throw new OfxParseError('No <OFX> element found; is this an OFX or QFX file?');
  return { version, root: ofx };
}

function child(node: Node | undefined, name: string): Node | undefined {
  return node?.children.find((n) => n.name === name);
}

function leaf(node: Node | undefined, name: string): string | undefined {
  return child(node, name)?.value;
}

function descendants(node: Node, name: string): Node[] {
  const found: Node[] = [];
  for (const c of node.children) {
    if (c.name === name) found.push(c);
    found.push(...descendants(c, name));
  }
  return found;
}

const OFX_DATE =
  /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.(\d{1,3}))?)?\s*(?:\[([+-]?\d{1,2}(?:\.\d+)?)(?::[A-Za-z]+)?\])?$/;

/**
 * `YYYYMMDD[HHMMSS[.XXX]][[offset:TZ]]` to ISO-8601 UTC. A date with no time
 * is midnight. The zone offset is deliberately ignored: the wall-clock value
 * is stored as if it were UTC, so the calendar day the bank printed is the
 * day every date filter sees, the same as a CSV row. Shifting `20260802` by
 * ten hours would file a 2 August purchase under 1 August.
 */
export function parseOfxDate(text: string): string | undefined {
  const m = OFX_DATE.exec(text.trim());
  if (!m) return undefined;
  const [, y, mo, d, h = '0', mi = '0', s = '0', ms = '0'] = m;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms.padEnd(3, '0')),
  );
  if (Number.isNaN(utc)) return undefined;
  const date = new Date(utc);
  if (date.getUTCMonth() !== Number(mo) - 1) return undefined;
  return date.toISOString();
}

function parseOfxAmount(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const normalised = text.trim().replace(',', '.');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalised)) return undefined;
  const cents = Math.round(Number(normalised) * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function leaves(node: Node): Record<string, string> {
  const record: Record<string, string> = {};
  for (const c of node.children) if (c.value !== undefined) record[c.name] = c.value;
  return record;
}

/** Parses the whole file into accounts with their transactions and balances. */
export function parseOfx(text: string): OfxDocument {
  const { version, root } = parseOfxTree(text);
  const institution = leaf(child(child(child(root, 'SIGNONMSGSRSV1'), 'SONRS'), 'FI'), 'ORG');
  const errors: OfxDocument['errors'] = [];
  const accounts: OfxAccount[] = [];

  const statements = [
    ...descendants(root, 'STMTRS').map((node) => ({ node, card: false })),
    ...descendants(root, 'CCSTMTRS').map((node) => ({ node, card: true })),
  ];
  if (!statements.length) throw new OfxParseError('The file has no bank or credit card statement.');

  for (const { node, card } of statements) {
    const from = child(node, card ? 'CCACCTFROM' : 'BANKACCTFROM');
    const accountId = leaf(from, 'ACCTID');
    if (!accountId) throw new OfxParseError('A statement has no ACCTID.');
    const bankId = leaf(from, 'BANKID');
    const accountType = card ? 'CREDITCARD' : (leaf(from, 'ACCTTYPE') ?? 'CHECKING');
    const currency = (leaf(node, 'CURDEF') ?? 'AUD').toUpperCase();
    const list = child(node, 'BANKTRANLIST');
    const transactions: OfxTransaction[] = [];
    for (const trn of list?.children.filter((c) => c.name === 'STMTTRN') ?? []) {
      const raw = leaves(trn);
      const fitId = raw.FITID ?? '';
      if (!fitId) {
        errors.push({ fitId: '(missing)', message: 'transaction has no FITID' });
        continue;
      }
      const postedAt = raw.DTPOSTED === undefined ? undefined : parseOfxDate(raw.DTPOSTED);
      if (!postedAt) {
        errors.push({ fitId, message: `DTPOSTED "${raw.DTPOSTED ?? ''}" is not an OFX date` });
        continue;
      }
      const amountCents = parseOfxAmount(raw.TRNAMT);
      if (amountCents === undefined) {
        errors.push({ fitId, message: `TRNAMT "${raw.TRNAMT ?? ''}" is not an amount` });
        continue;
      }
      const userDate = raw.DTUSER === undefined ? undefined : parseOfxDate(raw.DTUSER);
      transactions.push({
        fitId,
        type: raw.TRNTYPE ?? 'OTHER',
        postedAt,
        ...(userDate === undefined ? {} : { userDate }),
        amountCents,
        ...(raw.NAME === undefined ? {} : { name: raw.NAME }),
        ...(raw.MEMO === undefined ? {} : { memo: raw.MEMO }),
        ...(raw.CHECKNUM === undefined ? {} : { checkNumber: raw.CHECKNUM }),
        raw,
      });
    }
    const ledger = child(node, 'LEDGERBAL');
    const currentCents = parseOfxAmount(leaf(ledger, 'BALAMT'));
    const availableCents = parseOfxAmount(leaf(child(node, 'AVAILBAL'), 'BALAMT'));
    const asOf = leaf(ledger, 'DTASOF');
    const asOfIso = asOf === undefined ? undefined : parseOfxDate(asOf);
    const dateStart = leaf(list, 'DTSTART');
    const dateEnd = leaf(list, 'DTEND');
    const startIso = dateStart === undefined ? undefined : parseOfxDate(dateStart);
    const endIso = dateEnd === undefined ? undefined : parseOfxDate(dateEnd);
    accounts.push({
      externalId: bankId ? `${bankId}:${accountId}` : accountId,
      accountId,
      ...(bankId === undefined ? {} : { bankId }),
      accountType,
      currency,
      ...(institution === undefined ? {} : { institution }),
      ...(currentCents === undefined
        ? {}
        : {
            balance: {
              currentCents,
              ...(availableCents === undefined ? {} : { availableCents }),
              ...(asOfIso === undefined ? {} : { asOf: asOfIso }),
            },
          }),
      transactions,
      ...(startIso === undefined ? {} : { dateStart: startIso }),
      ...(endIso === undefined ? {} : { dateEnd: endIso }),
    });
  }
  return { version, ...(institution === undefined ? {} : { institution }), accounts, errors };
}

/** Maps the OFX account type onto the app's account types. */
export function accountTypeFromOfx(
  ofxType: string,
): 'transaction' | 'savings' | 'credit_card' | 'loan' | 'other' {
  switch (ofxType.toUpperCase()) {
    case 'CHECKING':
      return 'transaction';
    case 'SAVINGS':
    case 'MONEYMRKT':
      return 'savings';
    case 'CREDITCARD':
      return 'credit_card';
    case 'CREDITLINE':
      return 'loan';
    default:
      return 'other';
  }
}

/** `TRNTYPE`, `NAME` and `MEMO` joined, which is what a bank shows on a statement line. */
export function ofxDescription(transaction: OfxTransaction): string {
  const parts = [transaction.name, transaction.memo].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  // The memo often repeats the name; keep one copy.
  const unique = parts.filter((part, i) => parts.findIndex((p) => p.trim() === part.trim()) === i);
  const text = unique.join(' ').trim();
  return text || transaction.type;
}
