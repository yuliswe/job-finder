import { Box, Text } from 'ink';
import React from 'react';

import { listTagOptions, tagOption } from 'src/tui/utils/tags.js';

/** Inline tag-picker shown after the user hits `t` (mode='add' — every
 * configured tag, with a green ✓ on the ones already applied) or Shift+T
 * (mode='remove' — only the row's currently-applied tags). Pressing the
 * shortcut letter toggles the tag; Esc dismisses. */
export function TagMenuBar({
  activeTags,
  mode,
}: {
  activeTags: string[];
  mode: 'add' | 'remove';
}) {
  const options =
    mode === 'add' ? listTagOptions() : activeTags.map(t => tagOption(t));

  return (
    <Box marginTop={1} flexWrap='wrap'>
      <Text bold>{mode === 'add' ? 'tag: ' : 'untag: '}</Text>
      {options.length === 0 && <Text dimColor>(no tags on this row)</Text>}
      {options.map(opt => {
        const isActive = activeTags.includes(opt.key);
        return (
          <Box key={opt.key} marginRight={2}>
            <Text color={opt.inkColor}>●</Text>
            <Text> </Text>
            <Text color='cyan'>{opt.shortcut}</Text>
            <Text> {opt.label}</Text>
            {mode === 'add' && isActive && <Text color='green'> ✓</Text>}
          </Box>
        );
      })}
      <Box marginRight={2}>
        <Text color='cyan'>Esc</Text>
        <Text> cancel</Text>
      </Box>
    </Box>
  );
}
