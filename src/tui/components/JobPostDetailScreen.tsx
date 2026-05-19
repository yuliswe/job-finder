import { Box, Text, useInput } from 'ink';
import React, { type ReactNode, useEffect, useMemo, useState } from 'react';

import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import type { JobPostRow } from 'src/tui/queries.js';
import { copyToClipboard } from 'src/tui/utils/clipboard.js';
import { fmtSalary, fmtScore } from 'src/tui/utils/format.js';
import { openUrl } from 'src/tui/utils/openUrl.js';

/** Full-screen view of a single JobPost. Opened via Enter on the list,
 * dismissed via Esc/q. Summary + scoring + skill breakdown + description all
 * share one scrolling viewport so long text never gets truncated. */
export function JobPostDetailScreen({
  row,
  onClose,
}: {
  row: JobPostRow;
  onClose: () => void;
}) {
  const { rows: termRows, cols: termCols } = useTerminalSize();
  const [scroll, setScroll] = useState(0);

  // Reset scroll when the row changes (defensive — usually unmounted/remounted).
  useEffect(() => {
    setScroll(0);
  }, [row.id]);

  // The fixed top/bottom chrome is intentionally minimal so the wrapped
  // scoring/breakdown/description content has room to breathe.
  const FIXED_TOP = 5; // title, subtitle, url, marginTop, meta row
  const FIXED_BOTTOM = 3; // scroll-marginTop, scroll-position, footer
  const SAFETY = 1;
  const viewportRows = Math.max(
    5,
    termRows - FIXED_TOP - FIXED_BOTTOM - SAFETY
  );

  const scrollLines = useMemo(
    () => buildScrollLines(row, termCols - 4),
    [row, termCols]
  );

  const maxScroll = Math.max(0, scrollLines.length - viewportRows);
  const visible = scrollLines.slice(scroll, scroll + viewportRows);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }

    if (key.downArrow || input === 'j') {
      setScroll(s => Math.min(maxScroll, s + 1));
      return;
    }

    if (key.upArrow || input === 'k') {
      setScroll(s => Math.max(0, s - 1));
      return;
    }

    if (key.pageDown || input === ' ') {
      setScroll(s => Math.min(maxScroll, s + viewportRows));
      return;
    }

    if (key.pageUp) {
      setScroll(s => Math.max(0, s - viewportRows));
      return;
    }

    if (input === 'g') {
      setScroll(0);
      return;
    }

    if (input === 'G') {
      setScroll(maxScroll);
      return;
    }

    if (input === 'l') {
      openUrl(row.url);
      return;
    }

    if (input === 'y') {
      copyToClipboard(row.url);
      return;
    }
  });

  return (
    <Box flexDirection='column' width={termCols} height={termRows}>
      <Text bold color='cyan' wrap='truncate-end'>
        {row.title}
      </Text>
      <Text wrap='truncate-end'>
        {row.company ?? '(unknown company)'}
        {row.location ? ` · ${row.location}` : ''}
        {row.isRemote === 1 ? ' · remote' : ''}
      </Text>
      <Text dimColor wrap='truncate-end'>
        {row.url}
      </Text>
      <Box marginTop={1} flexDirection='row' columnGap={3}>
        <Text>
          posted <Text bold>{row.postedAt ?? '—'}</Text>
        </Text>
        <Text>
          salary{' '}
          <Text bold>
            {fmtSalary(row.salaryMin, row.salaryMax, row.salaryCurrency)}
          </Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection='column' flexGrow={1}>
        <Text dimColor>
          {scrollLines.length > viewportRows
            ? `${scroll + 1}–${Math.min(scroll + viewportRows, scrollLines.length)} of ${scrollLines.length}`
            : `${scrollLines.length} line${scrollLines.length === 1 ? '' : 's'}`}
        </Text>
        {visible.map((line, i) => (
          <React.Fragment key={i}>{line}</React.Fragment>
        ))}
      </Box>
      <Box>
        <Text dimColor>
          <Text color='cyan'>↑↓/jk</Text> scroll · <Text color='cyan'>g/G</Text>{' '}
          top/bottom · <Text color='cyan'>l</Text> open ·{' '}
          <Text color='cyan'>y</Text> copy url · <Text color='cyan'>Esc/q</Text>{' '}
          back
        </Text>
      </Box>
    </Box>
  );
}

/** Flatten everything scrollable (summary, scoring reasons, skill breakdown,
 * description) into a list of one-line ReactNodes so they share one viewport
 * and long text wraps cleanly instead of truncating. */
function buildScrollLines(row: JobPostRow, width: number): ReactNode[] {
  const out: ReactNode[] = [];

  if (row.summary) {
    for (const line of wrapToWidth(row.summary, width)) {
      out.push(
        <Text italic key={out.length}>
          {line || ' '}
        </Text>
      );
    }

    out.push(<Text key={out.length}> </Text>);
  }

  const reasons: { label: string; score: number | null; reason: string }[] = [];
  if (row.overallScore != null) {
    reasons.push({
      label: 'overall',
      score: row.overallScore,
      reason: 'interest * skill',
    });
  }

  if (row.interestScoreReason) {
    reasons.push({
      label: 'interest',
      score: row.interestScore,
      reason: row.interestScoreReason,
    });
  }

  if (row.skillScore != null) {
    reasons.push({
      label: 'skill',
      score: row.skillScore,
      reason: 'weighted average score of skill breakdown',
    });
  }

  if (reasons.length > 0) {
    out.push(
      <Text bold color='magenta' key={out.length}>
        Scoring
      </Text>
    );
    for (const r of reasons) {
      out.push(
        <Text key={out.length}>
          <Text color='magenta'>{r.label} </Text>
          <Text bold>{fmtScore(r.score)}</Text>
        </Text>
      );
      for (const line of wrapToWidth(r.reason, width)) {
        out.push(
          <Text dimColor key={out.length}>
            {'  ' + (line || ' ')}
          </Text>
        );
      }
    }

    out.push(<Text key={out.length}> </Text>);
  }

  if (row.skillRequirements && row.skillRequirements.length > 0) {
    // skillRequirements (posting-derived, CV-free) is the source of truth for
    // the skill list + importance + reason. Per-skill match scores against the
    // CV come from JobPostEval.skillScoreBreakdown, joined here by skill name.
    const scoreByName = new Map(
      (row.skillScoreBreakdown ?? []).map(s => [
        s.skill,
        { skillScore: s.skillScore, skillScoreReason: s.skillScoreReason },
      ])
    );

    out.push(
      <Text bold color='magenta' key={out.length}>
        Skill breakdown <Text dimColor>(ranked by importance)</Text>
      </Text>
    );
    const sorted = [...row.skillRequirements].sort(
      (a, b) => b.importance - a.importance
    );

    for (const req of sorted) {
      const match = scoreByName.get(req.skill);
      const score = match != null ? req.importance * match.skillScore : null;

      out.push(
        <Text key={out.length}>
          <Text bold>{req.skill}</Text>
          {score != null ? (
            <Text color='cyan'> score {score.toFixed(2)}</Text>
          ) : (
            <Text dimColor> (not yet evaluated)</Text>
          )}
        </Text>
      );
      pushBreakdownReason(out, 'importance', req.importance, req.reason, width);
      if (match) {
        pushBreakdownReason(
          out,
          'your skill',
          match.skillScore,
          match.skillScoreReason,
          width
        );
      }
    }

    out.push(<Text key={out.length}> </Text>);
  }

  out.push(
    <Text bold color='magenta' key={out.length}>
      Description
    </Text>
  );
  if (row.description) {
    for (const line of wrapToWidth(row.description, width)) {
      out.push(<Text key={out.length}>{line || ' '}</Text>);
    }
  } else {
    out.push(
      <Text dimColor key={out.length}>
        (no description — run `jobfinder pipeline viewing`)
      </Text>
    );
  }

  return out;
}

/** Render a breakdown sub-block:
 *     <label>: <score>
 *     <reason wrapped at indent>
 * Both lines indent two spaces under the breakdown header. Skipped if the
 * reason text is empty. */
function pushBreakdownReason(
  out: ReactNode[],
  label: string,
  score: number,
  text: string | null | undefined,
  width: number
): void {
  if (!text) return;
  const indent = '  ';

  out.push(
    <Text dimColor key={out.length}>
      {`${indent}${label}: ${score.toFixed(2)}`}
    </Text>
  );
  const bodyWidth = Math.max(10, width - indent.length);
  for (const line of wrapToWidth(text, bodyWidth)) {
    out.push(
      <Text dimColor key={out.length}>
        {`${indent}${line || ' '}`}
      </Text>
    );
  }
}

/** Soft-wrap `text` at `width`, splitting on whitespace. Preserves existing
 * line breaks (including blank lines between paragraphs). Normalizes
 * `\r\n` / `\r` to `\n` first, and converts JSON-style literal `\n` / `\t`
 * sequences (some viewJobPost results land in the DB pre-escaped) into the
 * actual whitespace characters. */
function wrapToWidth(text: string, width: number): string[] {
  if (!text) return [];
  const normalized = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\r\n?/g, '\n');

  if (width <= 0) return normalized.split('\n');
  const out: string[] = [];
  for (const para of normalized.split('\n')) {
    if (para.length === 0) {
      out.push('');
      continue;
    }

    if (para.length <= width) {
      out.push(para);
      continue;
    }

    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if ((line + word).length <= width) {
        line += word;
      } else if (line.length === 0) {
        out.push(word.slice(0, width));
        line = word.slice(width);
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }

    if (line.length > 0) out.push(line);
  }

  return out;
}
