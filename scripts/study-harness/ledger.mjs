// Renders docs/study-harness/requirement-ledger.md from the authoritative JSON ledger.
import { readFile, writeFile } from 'node:fs/promises';
const url = new URL('../../docs/study-harness/requirement-ledger.json', import.meta.url);
const ledger = JSON.parse(await readFile(url, 'utf8'));
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = items => items.length ? items.map(item => typeof item === 'string' ? item : `${item.path ?? item.command ?? ''}${item.note ? ` — ${item.note}` : ''}`).join('<br>') : '—';
const counts = ledger.requirements.reduce((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {});
const lines = [
  '# Requirement ledger',
  '',
  `Generated from [requirement-ledger.json](requirement-ledger.json) by \`node scripts/study-harness/ledger.mjs\`. The [report](../study-harness-visualizer-implementation-report.md) remains authoritative; this ledger is an execution aid. Status counts: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(', ')}.`,
  '',
  'Statuses: `verified` = implemented and backed by the listed reproducible evidence; `implemented` = implemented, with verification weaker than the criterion asks (the notes name the remainder); `external-gate` = engineering preparation complete but the criterion requires a person, credentials, another repository or another platform; `partially-external` = verified for the stated scope with a named external remainder.',
  '',
  'Evidence lists machine-readable records (docs/study-harness/evidence/*.json, the release pipeline\'s verification record) that back a row; Notes carry the remaining scope or caveats.',
  '',
  '| ID | Criterion | WP | Status | Implementation | Verification | Evidence | External dependency | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...ledger.requirements.map(row => `| ${row.id} | ${cell(row.criterion)} | ${row.workPackages.join(', ')} | ${row.status} | ${cell(list(row.implementation))} | ${cell(list(row.verification))} | ${cell(list(row.evidence ?? []))} | ${cell(row.externalDependency ?? '—')} | ${cell(row.notes || '—')} |`),
  '',
];
await writeFile(new URL('../../docs/study-harness/requirement-ledger.md', import.meta.url), lines.join('\n'));
