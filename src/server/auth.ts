import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';

/** A private, persistent password for the local web server. */
export function localPassword(path: string): string {
  try {
    writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Local access password must be a regular file.');
  chmodSync(path, 0o600);
  const password = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(password))
    throw new Error(
      'Local access password file is invalid. Remove it and restart to create a new one.',
    );
  return password;
}

/** HTTP Basic authentication, with a fixed username and constant-time comparison. */
export function checkLocalPassword(header: string | undefined, password: string): boolean {
  if (!header || header.length > 512 || !header.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`ledgerchat:${password}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
