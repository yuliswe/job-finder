import { Box, Text, useInput } from 'ink';
import React, { type ReactNode, useEffect, useMemo, useState } from 'react';
import { join } from 'node:path';

import { RESUME_OUTPUT_DIR } from 'jobfinder.config.js';
import { fillCvTemplate } from 'src/llm/fillCvTemplate.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import type { JobPostRow } from 'src/tui/queries.js';
import { copyToClipboard } from 'src/tui/utils/clipboard.js';
import { fmtSalary, fmtScore } from 'src/tui/utils/format.js';
import { openFile } from 'src/tui/utils/openFile.js';
import { openUrl } from 'src/tui/utils/openUrl.js';
import { buildCvFilename } from 'src/utils/cvFilename.js';
import { renderCvPdf } from 'src/utils/renderCvPdf.js';
import type { Terminal } from 'src/utils/terminal.js';

/** How many feedbackLoop log lines to surface under the "generating…" status
 * line. Newest at the bottom; older lines are dropped to keep the footer
 * compact when retries pile up. */
const MAX_PDF_LOG_LINES = 6;

type PdfLogLine = {
  level: 'log' | 'warn' | 'error' | 'llmRequest' | 'llmResponse';
  msg: string;
};

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
  // PDF generation status (LLM fill → chromium render → openFile). Tracked
  // here so the footer can show progress / errors and the keyboard handler
  // can ignore a second 'p' press while a previous one is still in flight.
  const [pdfStatus, setPdfStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'generating' }
    | { kind: 'opened'; path: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const [pdfLog, setPdfLog] = useState<PdfLogLine[]>([]);

  // Reset scroll AND PDF status when the row changes (defensive — usually
  // unmounted/remounted).
  useEffect(() => {
    setScroll(0);
    setPdfStatus({ kind: 'idle' });
    setPdfLog([]);
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

    if (input === 'p') {
      // Ignore repeat presses while a previous run is in flight — the LLM
      // call + chromium launch take seconds.
      if (pdfStatus.kind === 'generating') return;
      void generateAndOpenCvPdf(row, setPdfStatus, setPdfLog);
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
          <Text color='cyan'>y</Text> copy url · <Text color='cyan'>p</Text>{' '}
          tailored CV pdf · <Text color='cyan'>Esc/q</Text> back
        </Text>
      </Box>
      {pdfStatus.kind !== 'idle' && (
        <Box flexDirection='column'>
          {pdfStatus.kind === 'generating' && (
            <Text color='yellow'>generating tailored CV pdf…</Text>
          )}
          {pdfStatus.kind === 'opened' && (
            <Text color='green'>opened {pdfStatus.path}</Text>
          )}
          {pdfStatus.kind === 'error' && (
            <Text color='red'>pdf failed: {pdfStatus.message}</Text>
          )}
          {pdfLog.map((line, i) => (
            <Text key={i} color={colorForLogLevel(line.level)} dimColor>
              {'  '}
              {truncate(line.msg, Math.max(20, termCols - 4))}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Fill the CV template for `row` via the LLM, render the resulting HTML to
 * a temp PDF via headless Chromium, and open it with the platform's default
 * viewer. Updates `setStatus` at each transition. Failure modes (missing
 * description, missing cv/template seed files, LLM error, chromium error)
 * all surface as a single short message in the footer. */
async function generateAndOpenCvPdf(
  row: JobPostRow,
  setStatus: (
    s:
      | { kind: 'idle' }
      | { kind: 'generating' }
      | { kind: 'opened'; path: string }
      | { kind: 'error'; message: string }
  ) => void,
  setLog: React.Dispatch<React.SetStateAction<PdfLogLine[]>>
): Promise<void> {
  setStatus({ kind: 'generating' });
  setLog([]);
  const logger = makeCapturingLogger(setLog);
  // Stage milestones make the slow happy path (LLM 30-60s + chromium 1-2s)
  // legible — without these the user sees only the static "generating…"
  // line, since feedbackLoop is silent unless something fails.
  const stage = (msg: string): void => {
    logger.log(msg);
  };

  try {
    if (!row.description) {
      throw new Error(
        'JobPost has no description — run `jobfinder pipeline viewing` first'
      );
    }

    if (!row.skillRequirements || row.skillRequirements.length === 0) {
      throw new Error(
        'JobPost has no skillRequirements — run `jobfinder pipeline viewing` first'
      );
    }

    stage(
      `calling LLM (${row.skillRequirements.length} skills, ${row.description.length.toLocaleString()} chars of JD)…`
    );

    const { html, sanitizations } = await fillCvTemplate({
      skillRequirements: row.skillRequirements,
      job: {
        title: row.title,
        description: row.description,
        location: row.location,
        isRemote: row.isRemote,
      },
      logger,
    });

    const sanitTotal = Object.values(sanitizations).reduce((a, b) => a + b, 0);

    stage(
      `LLM done: ${html.length.toLocaleString()} chars, ${sanitTotal} ATS char replacement(s)`
    );

    const format = inferPageFormat(row.location);
    const outputPath = join(
      RESUME_OUTPUT_DIR,
      buildCvFilename({ company: row.company, title: row.title })
    );

    stage(`rendering PDF (${format}) → ${outputPath}`);
    const { path } = await renderCvPdf({ html, outputPath, format });
    stage(`opening ${path}`);
    openFile(path);
    setStatus({ kind: 'opened', path });
  } catch (err) {
    setStatus({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build a Terminal-shaped logger that pushes each call into the TUI's
 * pdfLog state instead of writing to stdout (which would corrupt ink's
 * render). Caps the buffer at `MAX_PDF_LOG_LINES`, newest at the bottom. */
function makeCapturingLogger(
  setLog: React.Dispatch<React.SetStateAction<PdfLogLine[]>>
): Terminal {
  const push = (level: PdfLogLine['level']) => (msg: string) => {
    setLog(prev => {
      const next = [...prev, { level, msg }];
      return next.length > MAX_PDF_LOG_LINES
        ? next.slice(next.length - MAX_PDF_LOG_LINES)
        : next;
    });
  };

  return {
    log: push('log'),
    warn: push('warn'),
    error: push('error'),
    llmRequest: push('llmRequest'),
    llmResponse: push('llmResponse'),
  };
}

function colorForLogLevel(level: PdfLogLine['level']): string {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'yellow';
  if (level === 'llmRequest') return 'gray';
  if (level === 'llmResponse') return 'cyan';
  return 'white';
}

/** Trim `s` to fit `width` (incl. ellipsis). Keeps the head of the message
 * so the level and "what we tried" are visible — usually more useful than
 * the trailing detail when multiple lines stack up. */
function truncate(s: string, width: number): string {
  // Collapse newlines so multi-line log strings don't blow up the footer.
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  return flat.slice(0, Math.max(1, width - 1)) + '…';
}

/** US/Canada → Letter, everything else → A4. Same heuristic career-ops
 * applies. Falls back to Letter when the location string is empty. */
function inferPageFormat(location: string | null): 'Letter' | 'A4' {
  if (!location) return 'Letter';
  return /\b(usa?|united states|us|canada|ca|on|ontario|quebec|qc|bc|alberta|ab|manitoba|saskatchewan)\b/i.test(
    location
  )
    ? 'Letter'
    : 'A4';
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
      reason: 'interest * skill * location',
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

  if (row.locationScoreReason) {
    reasons.push({
      label: 'location',
      score: row.locationScore,
      reason: row.locationScoreReason,
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
