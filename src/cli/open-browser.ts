import { spawn } from 'node:child_process';

/**
 * Opens a web page in the default browser. Returns false when it cannot even try; a browser that
 * fails to start goes unnoticed, so callers also print the address.
 */
export function openBrowser(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  // cmd's `start` would split the address at every &.
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]]
      : process.platform === 'darwin'
        ? ['open', [url.href]]
        : ['xdg-open', [url.href]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
