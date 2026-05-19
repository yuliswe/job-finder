import { spawn } from 'node:child_process';

/** Open `url` in the system's default browser. */
export function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';

  try {
    const p = spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
    });

    p.on('error', () => {
      // No opener available — silently no-op.
    });
    p.unref();
  } catch {
    // ignore
  }
}
