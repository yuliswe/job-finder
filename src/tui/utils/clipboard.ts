import { spawn } from 'node:child_process';

/** Copy `text` to the system clipboard using the host platform's CLI tool. */
export function copyToClipboard(text: string): void {
  // macOS pbcopy, Linux xclip / wl-copy, Windows clip.
  const cmd =
    process.platform === 'darwin'
      ? 'pbcopy'
      : process.platform === 'win32'
        ? 'clip'
        : 'xclip';

  const args = cmd === 'xclip' ? ['-selection', 'clipboard'] : [];
  try {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });

    p.on('error', () => {
      // No clipboard tool available — silently no-op.
    });
    p.stdin.end(text);
  } catch {
    // ignore
  }
}
