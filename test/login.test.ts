import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginCommand, type LoginIo, type LoginOptions } from '../src/commands/login.ts';
import { readCredentials } from '../src/credentials.ts';
import { EXIT } from '../src/errors.ts';
import { FAKE_TOKEN, fakeAuthServer, type FakeAuthOptions } from './helpers/fakeAuth.ts';
import { rmTmp } from './helpers/tmp.ts';

interface Captured {
  io: LoginIo;
  stdout: () => string;
  stderr: () => string;
  all: () => string;
  opened: string[];
  credsPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

const dirs: string[] = [];

function capture(extra: Partial<LoginIo> & { browserOpens?: boolean } = {}): Captured {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velxio-login-'));
  dirs.push(dir);
  const credsPath = path.join(dir, 'velxio', 'credentials');
  const env = { VELXIO_CLI_CREDENTIALS: credsPath } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const io: LoginIo = {
    out: {
      stdout: (d) => out.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')),
      stderr: (t) => err.push(t),
    },
    readLine: async () => null,
    env,
    hostname: 'testbox',
    openBrowser: (url) => {
      opened.push(url);
      return extra.browserOpens ?? true;
    },
    ...extra,
  };
  return {
    io,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    all: () => out.join('') + err.join(''),
    opened,
    credsPath,
    env,
    cleanup: () => rmTmp(dir),
  };
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function login(opts: LoginOptions, server: { url: string }, c: Captured): Promise<number> {
  return loginCommand({ ...opts, server: server.url }, c.io);
}

function serve(opts: FakeAuthOptions = {}) {
  return fakeAuthServer(opts);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmTmp(d);
});

describe('velxio-cli login (device flow, PROTOCOL.md 1.7)', () => {
  test('the happy path: asks, opens the browser, polls, stores, reports who and what plan', async () => {
    const s = serve({ polls: ['pending', 'pending', 'ok'] });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(s.deviceRequests[0]).toEqual({ cli_version: expect.any(String), hostname: 'testbox', purpose: 'local' });
      expect(s.pollRequests[0]).toEqual({ device_code: 'f'.repeat(32) });
      expect(s.pollRequests.length).toBe(3);
      expect(c.opened).toEqual([`${s.url}/ci/device?code=K7RM-9TQX`]);
      expect(c.all()).toContain('K7RM-9TQX');
      // Stored, 0600, and the identity block that whoami prints.
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
      if (process.platform !== 'win32') expect(fs.statSync(c.credsPath).mode & 0o777).toBe(0o600);
      expect(c.stdout()).toContain('s3***@moontero.com');
      expect(c.stdout()).toContain('plan     pro');
      expect(c.stdout()).not.toContain(FAKE_TOKEN);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('--server points the whole flow at staging and is remembered', async () => {
    const s = serve();
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(readCredentials(c.env).server).toBe(s.url);
      expect(s.paths).toEqual(['/api/pro/ci/auth/device', '/api/pro/ci/auth/token', '/api/pro/ci/whoami']);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('slow_down raises the interval before the next poll', async () => {
    const s = serve({ interval: 0.05, polls: ['pending', 'slow_down', 'ok'], slowDownInterval: 0.45 });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(s.pollAt.length).toBe(3);
      const beforeSlowDown = s.pollAt[1]! - s.pollAt[0]!;
      const afterSlowDown = s.pollAt[2]! - s.pollAt[1]!;
      expect(beforeSlowDown).toBeLessThan(300);
      expect(afterSlowDown).toBeGreaterThanOrEqual(400);
      expect(c.stderr()).toContain('slow down');
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('a slow_down without an interval of its own still backs off (RFC 8628: +5 s)', async () => {
    const s = serve({ interval: 1, polls: ['slow_down', 'ok'] });
    const c = capture();
    const sleeps: number[] = [];
    c.io.sleep = async (ms) => {
      sleeps.push(ms);
    };
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(sleeps).toEqual([1000, 6000]);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('a denial in the browser exits 3 and stores nothing', async () => {
    const s = serve({ polls: ['pending', 'deny'] });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.AUTH);
      expect(c.stderr()).toContain('access_denied');
      expect(fs.existsSync(c.credsPath)).toBe(false);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('an expired code exits 3, offers a retry and stores nothing', async () => {
    const s = serve({ polls: ['expired'] });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.AUTH);
      expect(c.stderr()).toContain('expired_token');
      expect(c.stderr()).toContain('velxio-cli login` again');
      expect(fs.existsSync(c.credsPath)).toBe(false);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('the local expiry fires even when the server keeps saying pending', async () => {
    const s = serve({ interval: 0.01, expiresIn: 0.05, polls: ['pending'] });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.AUTH);
      expect(c.stderr()).toContain('expired');
      expect(fs.existsSync(c.credsPath)).toBe(false);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('402 pro_required exits 3 with the pricing hint', async () => {
    const s = serve({ polls: ['pro_required'] });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.AUTH);
      expect(c.stderr()).toContain('pro_required');
      expect(c.stderr()).toContain('/pricing?from=ci');
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('no browser is not a failure: the URL is printed and the poll continues', async () => {
    const s = serve({ polls: ['pending', 'ok'] });
    const c = capture({ browserOpens: false });
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(c.stderr()).toContain('no browser could be opened');
      expect(c.stdout()).toContain(`${s.url}/ci/device?code=K7RM-9TQX`);
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('--no-browser never spawns one', async () => {
    const s = serve();
    const c = capture();
    try {
      expect(await login({ browser: false }, s, c)).toBe(EXIT.PASS);
      expect(c.opened).toEqual([]);
      expect(c.stderr()).toContain('--no-browser');
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('Ctrl-C during the wait exits 130 and leaves nothing behind', async () => {
    const s = serve({ interval: 0.05, polls: ['pending'] });
    const controller = new AbortController();
    const c = capture({ signal: controller.signal });
    try {
      setTimeout(() => controller.abort(), 120);
      expect(await login({}, s, c)).toBe(EXIT.INTERRUPT);
      expect(c.stderr()).toContain('cancelled');
      expect(fs.existsSync(c.credsPath)).toBe(false);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('the token is stored even when /whoami cannot confirm it', async () => {
    const s = serve({ whoami: false });
    const c = capture();
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
      expect(c.stderr()).toContain('could not confirm');
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('--json emits the device object and then the identity, never the local token', async () => {
    const s = serve({ polls: ['pending', 'ok'] });
    const c = capture();
    try {
      expect(await login({ json: true }, s, c)).toBe(EXIT.PASS);
      const lines = jsonLines(c.stdout()).filter((l) => l.t !== 'note');
      expect(lines.map((l) => l.t)).toEqual(['login.device', 'login', 'whoami']);
      expect(lines[0]!.user_code).toBe('K7RM-9TQX');
      expect(lines[1]!.stored).toBe(true);
      expect(lines[1]!.token).toBeUndefined();
      expect(lines[2]!.plan).toBe('pro');
    } finally {
      s.stop();
      c.cleanup();
    }
  });
});

describe('velxio-cli login --ci', () => {
  test('mints with purpose ci and the given name, prints the token and stores nothing', async () => {
    const s = serve({ name: 'acme/blinker', polls: ['pending', 'ok'] });
    const c = capture();
    try {
      expect(await login({ ci: true, name: 'acme/blinker' }, s, c)).toBe(EXIT.PASS);
      expect(s.deviceRequests[0]).toEqual({ cli_version: expect.any(String), hostname: 'testbox', purpose: 'ci', name: 'acme/blinker' });
      const out = c.stdout();
      expect(out).toContain(FAKE_TOKEN);
      expect(out).toContain(`export VELXIO_CLI_TOKEN=${FAKE_TOKEN}`);
      expect(out).toContain('gh secret set VELXIO_CLI_TOKEN');
      expect(out).toContain('${{ secrets.VELXIO_CLI_TOKEN }}');
      expect(out).toContain('shown once');
      expect(out).toContain('acme/blinker');
      expect(fs.existsSync(c.credsPath)).toBe(false);
      // Nothing to confirm: no whoami call is made for a token we do not hold.
      expect(s.paths).not.toContain('/api/pro/ci/whoami');
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('--ci --json carries the token in one object and says it was not stored', async () => {
    const s = serve();
    const c = capture();
    try {
      expect(await login({ ci: true, json: true }, s, c)).toBe(EXIT.PASS);
      const lines = jsonLines(c.stdout()).filter((l) => l.t !== 'note');
      expect(lines.map((l) => l.t)).toEqual(['login.device', 'login']);
      expect(lines[1]).toMatchObject({ purpose: 'ci', stored: false, token: FAKE_TOKEN, plan: 'pro' });
      expect(fs.existsSync(c.credsPath)).toBe(false);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('--name without --ci and --ci with --token are config errors', async () => {
    const s = serve();
    const c1 = capture();
    const c2 = capture();
    try {
      expect(await login({ name: 'acme/blinker' }, s, c1)).toBe(EXIT.CONFIG);
      expect(c1.stderr()).toContain('--name labels a CI token');
      expect(await login({ ci: true, token: FAKE_TOKEN }, s, c2)).toBe(EXIT.CONFIG);
      expect(s.deviceRequests.length).toBe(0);
    } finally {
      s.stop();
      c1.cleanup();
      c2.cleanup();
    }
  });
});

describe('velxio-cli login --token (the paste path stays)', () => {
  test('--token stores without asking the device endpoints', async () => {
    const s = serve();
    const c = capture();
    try {
      expect(await login({ token: FAKE_TOKEN }, s, c)).toBe(EXIT.PASS);
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
      expect(s.deviceRequests.length).toBe(0);
      expect(s.pollRequests.length).toBe(0);
      expect(s.paths).toEqual(['/api/pro/ci/whoami']);
      expect(c.stdout()).toContain('plan     pro');
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('a token on stdin is stored when stdin is not a TTY', async () => {
    const s = serve();
    const c = capture({ stdinIsTTY: false, readLine: async () => `${FAKE_TOKEN}\n` });
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
      expect(s.deviceRequests.length).toBe(0);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('empty stdin falls through to the device flow', async () => {
    const s = serve();
    const c = capture({ stdinIsTTY: false, readLine: async () => '' });
    try {
      expect(await login({}, s, c)).toBe(EXIT.PASS);
      expect(s.deviceRequests.length).toBe(1);
      expect(readCredentials(c.env).token).toBe(FAKE_TOKEN);
    } finally {
      s.stop();
      c.cleanup();
    }
  });

  test('a malformed pasted token exits 3 and writes nothing', async () => {
    const s = serve();
    const c = capture();
    try {
      expect(await login({ token: 'wokwi_nope' }, s, c)).toBe(EXIT.AUTH);
      expect(fs.existsSync(c.credsPath)).toBe(false);
      expect(c.stderr()).toContain('malformed token');
    } finally {
      s.stop();
      c.cleanup();
    }
  });
});
