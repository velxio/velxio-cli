import { CliError } from '../../src/errors.ts';

/**
 * The CliError `fn` throws. Fails the test when `fn` returns normally or
 * throws something else, so an error-path assertion can never pass by not
 * running.
 */
export function thrown(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CliError) return err;
    throw new Error(`expected a CliError, got ${String(err)}`);
  }
  throw new Error('expected a CliError, nothing was thrown');
}
