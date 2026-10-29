import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validArchivalRecord } from '../../examples/study-harness-tauri/scripts/conformance-checks.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = path.join(root, 'examples/study-harness-tauri/scripts/conformance.mjs');

test('--no-build refuses a release/ACL check before creating evidence or launching an app', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'sh-no-build-release-'));
  try {
    for (const selection of [[], ['--only=release'], ['--only=offline,release']]) {
      const result = spawnSync(process.execPath, [runner, '--no-build', `--evidence-dir=${output}`, ...selection], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--no-build cannot include the release chain.*ACL checks require snapshots from both builds.*Nothing was run or written/);
      assert.equal(result.stdout, '');
      assert.deepEqual(readdirSync(output), []);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('a withdrawn-approval archival record offers exactly the host return action and keeps its records', () => {
  const valid = {
    archivalElement: true, surfaceMounted: false, controls: 1, controlLabels: ['button:Return to the session'],
    cardState: 'archival', archival: { codes: ['CONTENT_REVOKED'] }, recordsKept: true,
  };
  assert.equal(validArchivalRecord(valid), true);
  for (const change of [
    { controls: 0, controlLabels: [] },
    { controls: 2, controlLabels: ['button:Return to the session', 'button:Resume'] },
    { controls: 1, controlLabels: ['button:Resume'] },
    { controls: 1, controlLabels: [] },
    { controls: 1, controlLabels: undefined },
    { archivalElement: false },
    { surfaceMounted: true },
    { cardState: 'ready' },
    { archival: { codes: [] } },
    { recordsKept: false },
  ]) assert.equal(validArchivalRecord({ ...valid, ...change }), false, JSON.stringify(change));
  assert.equal(validArchivalRecord(null), false);
  assert.equal(validArchivalRecord(undefined), false);
});
