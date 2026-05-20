import { Box, Text } from 'ink';
import React from 'react';

const HINTS: { keys: string; label: string }[] = [
  { keys: '↑↓', label: 'nav' },
  { keys: '←→/Tab', label: 'tab' },
  { keys: 'Enter', label: 'open (Job / Source)' },
  { keys: 'p', label: 'pipeline focus' },
  { keys: 's', label: 'sort (JobPost)' },
  { keys: 'a', label: 'toggle active (Source)' },
  { keys: 'l', label: 'open url' },
  { keys: 'y', label: 'copy state cmd' },
  { keys: 'q/Esc', label: 'quit' },
];

export function Footer() {
  return (
    <Box marginTop={1}>
      {HINTS.map(h => (
        <Box key={h.keys} marginRight={2}>
          <Text color='cyan'>{h.keys}</Text>
          <Text> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
