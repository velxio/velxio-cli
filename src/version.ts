import pkg from '../package.json';

// The release workflow bakes the tag in with `bun build --define
// VELXIO_CLI_VERSION='"1.2.3"'`; a dev checkout falls back to package.json.
declare const VELXIO_CLI_VERSION: string | undefined;

export const VERSION: string =
  typeof VELXIO_CLI_VERSION === 'string' && VELXIO_CLI_VERSION ? VELXIO_CLI_VERSION : pkg.version;

export const USER_AGENT = `velxio-cli/${VERSION}`;
