import { spawn } from 'node:child_process';

/**
 * Open a URL in whatever the desktop uses. Best effort by design: a headless
 * box, a container or an SSH session has no browser, and that is never an
 * error here - the caller has already printed the URL.
 *
 * `true` only means the helper was launched; a helper that fails afterwards
 * (ENOENT arrives asynchronously) is silent, which is why the URL is always
 * on screen.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', `"${url}"`]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd!, args as string[], { stdio: 'ignore', detached: platform !== 'win32', windowsVerbatimArguments: platform === 'win32' });
    child.on('error', () => {
      // No xdg-open / no display: the printed URL is the fallback.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
