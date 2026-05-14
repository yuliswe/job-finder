import { Alert, Badge } from '@inkjs/ui';
import { Box, Text, useApp, useInput } from 'ink';
import React, { useMemo, useState } from 'react';

import { JOBS, TABS } from 'src/tui/data.js';
import { Table } from 'src/tui/Table.js';
import type { Tab } from 'src/tui/types.js';

type View = 'list' | 'table';

const SUB_STATS = [
  { label: 'Entrevista', value: 10 },
  { label: 'Aplicado', value: 66 },
  { label: 'Evaluada', value: 154 },
  { label: 'No aplicar', value: 219, color: 'red' as const },
  { label: 'Rechazado', value: 11 },
  { label: 'Descartado', value: 56 },
];

const FOOTER_HINTS: { keys: string; label: string }[] = [
  { keys: '↑↓', label: 'nav' },
  { keys: '↔', label: 'tabs' },
  { keys: 's', label: 'sort' },
  { keys: 'Enter', label: 'report' },
  { keys: 'c', label: 'cambiar' },
  { keys: 'v', label: 'vista' },
  { keys: 'Esc', label: 'cerrar' },
];

const COL = {
  score: 4,
  company: 22,
  title: 50,
  status: 12,
  salary: 12,
};

export function App() {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<Tab>('EVALUADA');
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<View>('list');

  const rows = useMemo(() => JOBS, []);

  useInput((input, key) => {
    if (input === 'q' || key.escape) exit();
    if (input === 'v') setView(v => (v === 'list' ? 'table' : 'list'));
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(rows.length - 1, c + 1));
    if (key.leftArrow || key.rightArrow) {
      const idx = TABS.findIndex(t => t.key === activeTab);
      const delta = key.rightArrow ? 1 : -1;
      const next = TABS[(idx + delta + TABS.length) % TABS.length]!;
      setActiveTab(next.key);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection='column'>
      <Header activeTab={activeTab} />
      <SubStats />
      <StatusLine shown={rows.length} view={view} />
      <SectionHeader title={`${activeTab} (${rows.length})`} />
      {view === 'list' ? (
        <JobList rows={rows} cursor={cursor} />
      ) : (
        <Table data={rows} columns={['score', 'company', 'title', 'status']} />
      )}
      <Box marginTop={1} flexDirection='column'>
        {/* eslint-disable react-native/no-raw-text */}
        <Alert variant='info'>
          TL;DR: Take agentic AI prototypes, deploy them into complex customer
          environments with guardrails, evals, and MCP integrations.
        </Alert>
        <Alert variant='success'>
          Remote: Denver, US – Dialpad offers hybrid/remote flexibility (offices
          in Denver, Dallas, Belmont).
        </Alert>
        {/* eslint-enable react-native/no-raw-text */}
      </Box>
      <Footer />
    </Box>
  );
}

function Header({ activeTab }: { activeTab: Tab }) {
  return (
    <Box justifyContent='space-between'>
      <Box>
        <Text bold color='magenta'>
          CAREER PIPELINE{' '}
        </Text>
        {TABS.map(t => {
          const active = t.key === activeTab;
          return (
            <Box key={t.key} marginRight={1}>
              <Text color={active ? 'red' : 'white'} bold={active}>
                {t.label}
              </Text>
              <Text> </Text>
              <Badge color={active ? 'red' : 'gray'}>{String(t.count)}</Badge>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>516 ofertas | Avg 3.4/5</Text>
    </Box>
  );
}

function SubStats() {
  return (
    <Box>
      {SUB_STATS.map((s, i) => (
        <Box key={s.label} marginRight={2}>
          <Text color={s.color ?? 'white'}>
            {s.label}:{s.value}
          </Text>
          {i < SUB_STATS.length - 1 ? <Text dimColor> </Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function StatusLine({ shown, view }: { shown: number; view: View }) {
  return (
    <Box>
      <Text dimColor>
        [Sort: score] [View: {view}] {shown} shown
      </Text>
    </Box>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Box
      marginTop={1}
      borderStyle='single'
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Text bold> {title}</Text>
    </Box>
  );
}

function JobList({ rows, cursor }: { rows: typeof JOBS; cursor: number }) {
  return (
    <Box flexDirection='column'>
      {rows.map((row, i) => {
        const selected = i === cursor;
        return (
          <Box key={`${row.company}-${row.title}`}>
            <Text inverse={selected}>
              {pad(row.score.toFixed(1), COL.score)}{' '}
              {pad(row.company, COL.company)} {pad(row.title, COL.title)}{' '}
              {pad(row.status, COL.status)} {pad(row.salary ?? '', COL.salary)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function Footer() {
  return (
    <Box marginTop={1}>
      {FOOTER_HINTS.map((h, i) => (
        <Box key={h.keys} marginRight={2}>
          <Text color='cyan'>{h.keys}</Text>
          <Text> {h.label}</Text>
          {i < FOOTER_HINTS.length - 1 ? <Text dimColor> </Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}
