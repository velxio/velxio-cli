import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readCredentials, writeCredentials } from '../src/credentials.ts';
import { rmTmp, tmpProject } from './helpers/tmp.ts';

describe('credentials file', () => {
  test.skipIf(process.platform === 'win32')('an existing world-readable file is replaced by a 0600 one, never rewritten in place', () => {
    const dir = tmpProject({ 'velxio/credentials': 'token = "old"\n' });
    const p = path.join(dir, 'velxio/credentials');
    fs.chmodSync(p, 0o644);
    const inodeBefore = fs.statSync(p).ino;
    const env = { VELXIO_CLI_CREDENTIALS: p } as NodeJS.ProcessEnv;
    try {
      const token = 'vlxci_' + 'd'.repeat(40);
      expect(writeCredentials({ token, server: 'https://vstaging.moontero.com' }, env)).toBe(p);
      const st = fs.statSync(p);
      expect(st.mode & 0o777).toBe(0o600);
      // A rename, not a write through the old 0644 inode.
      expect(st.ino).not.toBe(inodeBefore);
      expect(readCredentials(env)).toEqual({ token, server: 'https://vstaging.moontero.com' });
      expect(fs.readdirSync(path.dirname(p))).toEqual(['credentials']);
    } finally {
      rmTmp(dir);
    }
  });
});
