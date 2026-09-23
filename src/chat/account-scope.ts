export interface NamedAccount {
  id: number;
  name: string;
}

/** The tools can toggle transfers, but cannot express arbitrary exclusions. */
export function hasUnsupportedExclusion(question: string): boolean {
  const withoutTransferClause = question.replace(
    /\b(?:exclude|excluding|without|ignore)\s+(?:(?:internal|bank)\s+)?transfers?\b/gi,
    ' ',
  );
  return /\b(?:except|exclude|excluding|without|ignore)\b/i.test(withoutTransferClause);
}

function words(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Resolve explicit account or card references without guessing an identity. */
export function accountScope(question: string, accounts: readonly NamedAccount[]) {
  const normalised = ` ${words(question)} `;
  const all =
    /\b(?:all|across)\s+(?:my\s+)?accounts\b|\bmy\s+accounts\b|\baccount\s+balances\b/i.test(
      question,
    );
  const accountWord = /\baccounts?\b/i.test(question);
  const cardWord = /\bcards?\b/i.test(question);
  const ids = new Set<number>();
  for (const match of question.matchAll(/\baccount\s*#?\s*(\d+)\b/gi)) ids.add(Number(match[1]));
  if (!all)
    for (const account of accounts) {
      const name = words(account.name);
      if (!name || !normalised.includes(` ${name} `)) continue;
      if (
        accountWord ||
        cardWord ||
        normalised.includes(` my ${name} spending `) ||
        normalised.includes(` my ${name} balance `) ||
        ['on', 'in', 'from', 'for'].some(
          (preposition) =>
            normalised.includes(` ${preposition} ${name} `) ||
            normalised.includes(` ${preposition} my ${name} `),
        )
      )
        ids.add(account.id);
    }
  if (!all && accountWord && !cardWord && ids.size === 0 && accounts.length === 1)
    ids.add(accounts[0]!.id);
  return {
    ids: [...ids],
    all,
    ambiguous: (accountWord || cardWord) && !all && ids.size === 0,
  };
}
