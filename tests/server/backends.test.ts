import { describe, expect, it } from 'vitest';
import { processingLocation } from '../../src/server/backends.js';

describe('processing disclosure', () => {
  it.each([
    ['http://localhost:8080/v1', 'http://localhost:8080'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ])('names the local server %s', (url, origin) => {
    expect(processingLocation(url)).toEqual({ destination: origin });
  });
  it('discloses only the origin, never secrets or endpoint paths', () => {
    expect(
      processingLocation('http://user:secret@localhost:8000/private?key=secret#token'),
    ).toEqual({ destination: 'http://localhost:8000' });
  });
});
