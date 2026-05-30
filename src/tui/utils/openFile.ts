import { spawn } from 'node:child_process';

/** Open `absolutePath` in the system's default application — `open` on
 * macOS, `start` on Windows, `xdg-open` everywhere else. Fire-and-forget;
 * any errors from the opener are swallowed (matching `openUrl`). */
export function openFile(absolutePath: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';

  try {
    const p = spawn(cmd, [absolutePath], {
      stdio: 'ignore',
      detached: true,
    });

    p.on('error', () => {
      // no opener available — silently no-op
    });
    p.unref();
  } catch {
    // ignore
  }
}
