import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli.ts');
const FIXTURES = path.join(import.meta.dir, 'fixtures');

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, 'run', CLI, ...args], {
    env: { ...process.env, VELXIO_CLI_CREDENTIALS: '/nonexistent/creds', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe('velxio-cli process', () => {
  test('version and help', async () => {
    expect((await run(['version'])).stdout).toMatch(/^velxio-cli \d+\.\d+\.\d+\n$/);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('lint [options] [dir]');
  });

  test('login --help offers the browser flow, --ci and the paste path', async () => {
    const help = await run(['login', '--help']);
    expect(help.code).toBe(0);
    for (const flag of ['--ci', '--name <name>', '--no-browser', '--token <token>', '--server <url>']) {
      expect(help.stdout).toContain(flag);
    }
    expect(help.stdout).toContain('sign in through the browser');
  });

  test('lint passes on every fixture project', async () => {
    for (const [dir, board] of [
      ['uno-blink', 'arduino-uno'],
      ['wokwi-esp32', 'esp32-s3'],
      ['pico-uf2', 'pi-pico-w'],
      ['vlx-only', 'arduino-uno'],
    ]) {
      const r = await run(['lint', path.join(FIXTURES, dir!)]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`(${board},`);
      expect(r.stdout).toContain('lint passed');
    }
    const json = await run(['lint', '--json', path.join(FIXTURES, 'uno-blink')]);
    const lines = json.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const lint = lines.find((l) => l.t === 'lint')!;
    expect(lint.ok).toBe(true);
    expect(lint.board).toBe('arduino-uno');
    expect((lint.plan as unknown[]).length).toBe(5);
    expect(lint.blobs).toEqual([{ name: 'fw-uno', size: 144 }]);
    // wokwi.toml names no scenario: the fixture's YAML is only parsed when passed.
    const scenario = await run(['lint', '--json', '--scenario', 'scenario.yaml', path.join(FIXTURES, 'wokwi-esp32')]);
    expect(scenario.code).toBe(0);
    const plan = scenario.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.t === 'lint')!.plan as Array<{ kind: string }>;
    expect(plan.map((s) => s.kind)).toEqual(['wait-serial', 'set-control', 'delay', 'set-control', 'set-control', 'wait-serial', 'expect-pin']);
  });

  test('lint fails with exit 2 on a broken project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velxio-cli-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'velxio.toml'), '[velxio]\nversion = 1\nfirmware = "nope.hex"\n');
      fs.writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify({ version: 1, parts: [{ id: 'uno', type: 'wokwi-arduino-uno' }], connections: [['uno:1', 'ghost:2', 'red', []]] }));
      const r = await run(['lint', dir]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('unknown part "ghost"');
      const none = await run(['lint', os.tmpdir()]);
      expect(none.code).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('run without a token is exit 3; --vcd-file is exit 2; bad --timeout is exit 2', async () => {
    const noToken = await run(['run', path.join(FIXTURES, 'uno-blink')]);
    expect(noToken.code).toBe(3);
    expect(noToken.stderr).toContain('no API token');
    const vcd = await run(['run', '--vcd-file', 'x.vcd', path.join(FIXTURES, 'uno-blink')], { VELXIO_CLI_TOKEN: 'vlxci_' + 'c'.repeat(40) });
    expect(vcd.code).toBe(2);
    expect(vcd.stderr).toContain('--vcd-file is not supported yet');
    const bad = await run(['run', '--timeout', 'soon', path.join(FIXTURES, 'uno-blink')]);
    expect(bad.code).toBe(2);
    const longFail = await run(['lint', '--fail-text', 'x'.repeat(513), path.join(FIXTURES, 'uno-blink')]);
    expect(longFail.code).toBe(2);
    expect(longFail.stderr).toContain('--fail-text is 513 bytes, over the 512 byte limit');
  });

  test('init writes velxio.toml + diagram.json and refuses to overwrite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velxio-cli-init-'));
    try {
      const r = await run(['init', '--board', 'esp32-c3', dir]);
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'velxio.toml'), 'utf8')).toContain('board = "esp32-c3"');
      const d = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf8')) as { parts: Array<{ type: string }> };
      expect(d.parts[0]?.type).toBe('board-esp32-c3-devkitm-1');
      expect((await run(['init', dir])).code).toBe(2);
      expect((await run(['init', '--board', 'nope', dir])).code).toBe(2);
      const planned = await run(['init', '--force', '--board', 'esp32-cam', dir]);
      expect(planned.code).toBe(2);
      expect(planned.stderr).toContain('not available in Velxio CI yet');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('boards --offline lists the snapshot', async () => {
    const r = await run(['boards', '--offline']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('arduino-uno');
    expect(r.stdout).toContain('board-esp32-s3-devkitc-1');
    expect(r.stdout).toMatch(/esp32-devkit-c-v4 .* planned \(phase-\d\)/);
  });

  test('whoami against a dead server is exit 5; against nothing is exit 3', async () => {
    expect((await run(['whoami'])).code).toBe(3);
    const r = await run(['whoami', '--server', 'http://127.0.0.1:1'], { VELXIO_CLI_TOKEN: 'vlxci_' + 'c'.repeat(40) });
    expect(r.code).toBe(5);
  });
});
