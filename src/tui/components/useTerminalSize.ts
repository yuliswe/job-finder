import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

/**
 * Live terminal size. Updates on resize so tables re-flow as the user resizes
 * the window without remounting the TUI.
 */
export function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    rows: stdout?.rows ?? 40,
    cols: stdout?.columns ?? 120,
  }));
  useEffect(() => {
    if (!stdout) return;
    const handler = () => {
      setSize({ rows: stdout.rows ?? 40, cols: stdout.columns ?? 120 });
    };
    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout]);
  return size;
}
