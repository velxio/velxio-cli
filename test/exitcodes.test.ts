import { describe, expect, test } from 'bun:test';
import { exitCodeForClose, exitCodeForEnd, exitCodeForReject } from '../src/protocol/exitCodes.ts';
import { EXIT } from '../src/errors.ts';
import { resolveServer, resolveToken } from '../src/credentials.ts';
import { thrown } from './helpers/thrown.ts';

describe('exit codes', () => {
  test('reject codes map as PROTOCOL 1.3 says', () => {
    for (const c of ['unknown_board_type', 'board_not_supported_in_ci', 'board_not_launched', 'unsupported_part', 'firmware_format_mismatch', 'firmware_too_large', 'bundle_too_large', 'blob_missing', 'blob_sha_mismatch', 'scenario_invalid', 'scenario_part_missing', 'feature_unsupported', 'no_sim_clock', 'too_many_parts', 'bad_request']) {
      expect(exitCodeForReject(c)).toBe(2);
    }
    expect(exitCodeForReject('quota_exhausted')).toBe(4);
    expect(exitCodeForReject('concurrency')).toBe(4);
    for (const c of ['rate_limited', 'ci_disabled', 'server_error', 'something_new']) expect(exitCodeForReject(c)).toBe(5);
  });

  test('close codes: 4401/4402 are auth, the rest server', () => {
    expect(exitCodeForClose(4401)).toBe(3);
    expect(exitCodeForClose(4402)).toBe(3);
    for (const c of [4429, 4503, 4400, 1001, 1006, 1011, 1008]) expect(exitCodeForClose(c)).toBe(5);
  });

  test('run.end: status decides; timeout takes the flag; user cancel is 130', () => {
    const o = { timeoutExitCode: 42, cancelledByUser: false };
    expect(exitCodeForEnd({ status: 'passed', reason: 'plan_complete', exit_code: 0 }, o)).toBe(0);
    expect(exitCodeForEnd({ status: 'failed', reason: 'fail_text', exit_code: 1 }, o)).toBe(1);
    expect(exitCodeForEnd({ status: 'timeout', reason: 'budget_reached', exit_code: 42 }, o)).toBe(42);
    expect(exitCodeForEnd({ status: 'timeout', reason: 'budget_reached', exit_code: 42 }, { ...o, timeoutExitCode: 0 })).toBe(0);
    expect(exitCodeForEnd({ status: 'error', reason: 'engine_stalled', exit_code: 5 }, o)).toBe(5);
    expect(exitCodeForEnd({ status: 'lost', reason: 'heartbeat', exit_code: 5 }, o)).toBe(5);
    expect(exitCodeForEnd({ status: 'cancelled', reason: 'user', exit_code: 130 }, o)).toBe(130);
    expect(exitCodeForEnd({ status: 'cancelled', reason: 'client_disconnected', exit_code: 5 }, o)).toBe(5);
    expect(exitCodeForEnd({ status: 'cancelled', reason: 'client_disconnected', exit_code: 5 }, { ...o, cancelledByUser: true })).toBe(130);
  });

  test('token resolution: flag > VELXIO_CLI_TOKEN > VELXIO_CI_TOKEN; malformed and missing are exit 3', () => {
    const good = 'vlxci_' + 'a'.repeat(40);
    const other = 'vlxci_' + 'b'.repeat(40);
    const env = { VELXIO_CLI_TOKEN: good, VELXIO_CI_TOKEN: other, VELXIO_CLI_CREDENTIALS: '/nonexistent/creds' } as NodeJS.ProcessEnv;
    expect(resolveToken(undefined, env)).toBe(good);
    expect(resolveToken(other, env)).toBe(other);
    expect(resolveToken(undefined, { VELXIO_CI_TOKEN: other, VELXIO_CLI_CREDENTIALS: '/nonexistent/creds' } as NodeJS.ProcessEnv)).toBe(other);
    const missing = thrown(() => resolveToken(undefined, { WOKWI_CLI_TOKEN: 'x', VELXIO_CLI_CREDENTIALS: '/nonexistent/creds' } as NodeJS.ProcessEnv));
    expect(missing.exitCode).toBe(EXIT.AUTH);
    expect(missing.code).toBe('token_missing');
    expect(missing.hints.join(' ')).toContain('WOKWI_CLI_TOKEN');
    const malformed = thrown(() => resolveToken('vlxci_short', env));
    expect(malformed.exitCode).toBe(EXIT.AUTH);
    expect(malformed.code).toBe('token_malformed');
  });

  test('server resolution: https default, localhost http allowed, remote http refused', () => {
    const env = { VELXIO_CLI_CREDENTIALS: '/nonexistent/creds' } as NodeJS.ProcessEnv;
    expect(resolveServer(undefined, env)).toBe('https://velxio.dev');
    expect(resolveServer('https://vstaging.moontero.com/', env)).toBe('https://vstaging.moontero.com');
    expect(resolveServer('http://127.0.0.1:3080', env)).toBe('http://127.0.0.1:3080');
    expect(resolveServer(undefined, { ...env, VELXIO_CLI_SERVER: 'https://example.org' })).toBe('https://example.org');
    expect(() => resolveServer('http://example.org', env)).toThrow(/refusing plain http/);
    expect(() => resolveServer('ftp://x', env)).toThrow(/must be https/);
  });
});
