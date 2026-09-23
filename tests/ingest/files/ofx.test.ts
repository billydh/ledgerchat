import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  accountTypeFromOfx,
  ofxDescription,
  OfxParseError,
  parseOfx,
  parseOfxDate,
} from '../../../src/ingest/files/ofx.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../fixtures/files/${name}`, import.meta.url), 'utf8');

describe('parseOfxDate', () => {
  it('reads date, date-time and fractional forms and keeps the printed calendar day', () => {
    expect(parseOfxDate('20260802')).toBe('2026-08-02T00:00:00.000Z');
    expect(parseOfxDate('20260802143000')).toBe('2026-08-02T14:30:00.000Z');
    expect(parseOfxDate('20260802143000.123[+10:AEST]')).toBe('2026-08-02T14:30:00.123Z');
    expect(parseOfxDate('20260802000000[-5:EST]')).toBe('2026-08-02T00:00:00.000Z');
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseOfxDate('2026')).toBeUndefined();
    expect(parseOfxDate('20261301')).toBeUndefined();
    expect(parseOfxDate('20260230')).toBeUndefined();
  });
});

describe('parseOfx', () => {
  it('reads an OFX 1.x SGML bank statement with balances and a time zone', () => {
    const doc = parseOfx(fixture('sample-1x.ofx'));
    expect(doc.version).toBe('1');
    expect(doc.institution).toBe('Example Bank');
    expect(doc.errors).toEqual([]);
    expect(doc.accounts).toHaveLength(1);
    const account = doc.accounts[0]!;
    expect(account).toMatchObject({
      externalId: '062000:12345678',
      accountId: '12345678',
      bankId: '062000',
      accountType: 'CHECKING',
      currency: 'AUD',
      dateStart: '2026-08-01T00:00:00.000Z',
      dateEnd: '2026-08-31T00:00:00.000Z',
      balance: { currentCents: 418946, availableCents: 410000, asOf: '2026-08-31T23:59:59.000Z' },
    });
    expect(account.transactions.map((t) => [t.fitId, t.postedAt, t.amountCents])).toEqual([
      ['2026080201', '2026-08-02T00:00:00.000Z', -8420],
      ['2026080301', '2026-08-03T00:00:00.000Z', 320000],
      ['2026081501', '2026-08-15T00:00:00.000Z', -2299],
    ]);
    expect(account.transactions[1]).toMatchObject({ name: 'ACME PTY LTD', memo: 'SALARY & BONUS' });
  });

  it('reads an OFX 2.x XML credit card statement and reports a bad row without failing', () => {
    const doc = parseOfx(fixture('sample-2x.ofx'));
    expect(doc.version).toBe('2');
    const account = doc.accounts[0]!;
    expect(account).toMatchObject({
      externalId: '4111XXXXXXXX1111',
      accountType: 'CREDITCARD',
      currency: 'AUD',
      balance: { currentCents: -121055, asOf: '2026-08-31T00:00:00.000Z' },
    });
    expect(account.transactions.map((t) => t.fitId)).toEqual(['CC-1', 'CC-2']);
    expect(account.transactions[0]).toMatchObject({
      userDate: '2026-08-04T00:00:00.000Z',
      type: 'POS',
    });
    expect(doc.errors).toEqual([
      { fitId: 'CC-BAD', message: 'DTPOSTED "2026" is not an OFX date' },
    ]);
  });

  it('reads several statements from one file', () => {
    const two = fixture('sample-1x.ofx').replace(
      '</BANKMSGSRSV1>',
      `<STMTTRNRS><STMTRS><CURDEF>AUD<BANKACCTFROM><BANKID>062000<ACCTID>999<ACCTTYPE>SAVINGS</BANKACCTFROM>
       <BANKTRANLIST><STMTTRN><TRNTYPE>INT<DTPOSTED>20260831<TRNAMT>1.50<FITID>S1<NAME>INTEREST</STMTTRN></BANKTRANLIST>
       </STMTRS></STMTTRNRS></BANKMSGSRSV1>`,
    );
    const doc = parseOfx(two);
    expect(doc.accounts.map((a) => [a.externalId, a.accountType, a.transactions.length])).toEqual([
      ['062000:12345678', 'CHECKING', 3],
      ['062000:999', 'SAVINGS', 1],
    ]);
  });

  it('rejects a file that is not OFX or has no statement', () => {
    expect(() => parseOfx('Date,Amount\n2026-01-01,-1\n')).toThrow(OfxParseError);
    expect(() => parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toThrow(
      'no bank or credit card statement',
    );
    expect(() =>
      parseOfx(
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>AUD</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
      ),
    ).toThrow('ACCTID');
  });

  it('skips a transaction with no FITID or amount', () => {
    const doc = parseOfx(
      `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>AUD<BANKACCTFROM><ACCTID>1</BANKACCTFROM>
       <BANKTRANLIST>
       <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260801<TRNAMT>-1.00<NAME>NO ID</STMTTRN>
       <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260801<TRNAMT>abc<FITID>X<NAME>BAD AMOUNT</STMTTRN>
       <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260801<TRNAMT>-2.00<FITID>Y<NAME>OK</STMTTRN>
       </BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
    );
    expect(doc.accounts[0]!.transactions.map((t) => t.fitId)).toEqual(['Y']);
    expect(doc.errors.map((e) => e.fitId)).toEqual(['(missing)', 'X']);
    expect(doc.accounts[0]!.balance).toBeUndefined();
  });
});

describe('helpers', () => {
  it('maps OFX account types onto the app types', () => {
    expect(accountTypeFromOfx('CHECKING')).toBe('transaction');
    expect(accountTypeFromOfx('savings')).toBe('savings');
    expect(accountTypeFromOfx('CREDITCARD')).toBe('credit_card');
    expect(accountTypeFromOfx('CREDITLINE')).toBe('loan');
    expect(accountTypeFromOfx('CD')).toBe('other');
  });

  it('builds a description from name and memo without repeating them', () => {
    const base = {
      fitId: '1',
      type: 'POS',
      postedAt: '2026-08-01T00:00:00.000Z',
      amountCents: -1,
      raw: {},
    };
    expect(ofxDescription({ ...base, name: 'JB HI-FI', memo: 'JB HI-FI' })).toBe('JB HI-FI');
    expect(ofxDescription({ ...base, name: 'ACME', memo: 'SALARY' })).toBe('ACME SALARY');
    expect(ofxDescription({ ...base })).toBe('POS');
  });
});
