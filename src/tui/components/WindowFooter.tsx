import { Text } from 'ink';
import React from 'react';

export function WindowFooter({
  windowStart,
  windowEnd,
  total,
  visibleCount,
}: {
  windowStart: number;
  windowEnd: number;
  total: number;
  visibleCount: number;
}) {
  if (total <= visibleCount) return null;
  return (
    <Text dimColor>
      [{windowStart + 1}-{windowEnd} of {total}]
    </Text>
  );
}
