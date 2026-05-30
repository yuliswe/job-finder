import { Box, Text } from 'ink';
import React from 'react';

const HINTS: { keys: string; label: string }[] = [
  { keys: '↑↓', label: 'nav' },
  { keys: 'PgUp/Dn or U/D', label: 'page' },
  { keys: '←→/Tab', label: 'tab' },
  { keys: 'Enter', label: 'open (Job / Source)' },
  { keys: 'p', label: 'pipeline focus' },
  { keys: 's/S', label: 'sort next/prev' },
  { keys: 'a', label: 'toggle active (Source)' },
  { keys: 'o/O', label: 'scope all / out-of-scope only (Sources)' },
  { keys: 'l', label: 'open url' },
  { keys: 'y', label: 'copy state cmd' },
  { keys: 'q/Esc', label: 'quit' },
];

export function Footer() {
  return (
    <Box marginTop={1} flexWrap='wrap'>
      {HINTS.map(h => (
        <Box key={h.keys} marginRight={2}>
          <Text color='cyan'>{h.keys}</Text>
          <Text> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
