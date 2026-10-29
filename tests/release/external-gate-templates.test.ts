/**
 * External-gate preparation (report §1.2: prepare evidence for the second claim; §15.3, §17; G21 result templates,
 * G75): the G2 host conformance result and G3 agent trial templates are machine-checkable, label actual-host versus
 * fixture results, keep "not run" distinct from "pass", and stay consistent with external-gates.md and the recorder.
 * Nothing here is a G2 or G3 result: the records below are synthetic shapes for the schema, not runs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaErrors, type JsonSchema } from '@explorable-models/core/model';
import { AGENT_TRIAL_RECORD_SCHEMA, G3_STEPS, TRIAL_REPAIRS } from '@explorable-models/agent';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const hostSchema = JSON.parse(read('docs/study-harness/templates/host-conformance-result.schema.json')) as JsonSchema & { properties: { steps: { required: string[] } } };
const STEP_IDS = hostSchema.properties.steps.required;
const gates = read('docs/study-harness/external-gates.md');
const section = (id: string) => gates.slice(gates.indexOf(`## ${id} `), gates.indexOf('\n## ', gates.indexOf(`## ${id} `) + 4));

function result(subject: string, outcome = 'pass'): Record<string, unknown> {
  return {
    schema: 'study-harness.host-conformance-result/1', subject, runAt: '2026-10-26T12:00:00.000Z',
    host: { name: 'host-under-test', commit: 'a'.repeat(40), dirty: false, binarySha256: 'b'.repeat(64), platform: { os: 'macOS', osVersion: '26.6.2', arch: 'arm64', webview: 'WKWebView' } },
    packages: [{ name: '@explorable-models/activity', version: '0.3.0-preview.1', sha256: 'c'.repeat(64) }],
    steps: Object.fromEntries(STEP_IDS.map(id => [id, { outcome, assertions: [{ id: `${id}-holds`, outcome }] }])),
    result: outcome === 'pass' ? 'pass' : 'incomplete',
  };
}

describe('G2 host conformance result template (A54 preparation)', () => {
  it('lists the external-gates.md G2 sequence as twelve required steps, in the same words as the template', () => {
    expect(STEP_IDS).toHaveLength(12);
    const g2 = section('G2');
    for (const id of STEP_IDS) {
      expect(g2, id).toContain(`\`${id}\``);
      expect(read('docs/study-harness/templates/host-conformance-result.md'), id).toContain(`| \`${id}\` |`);
    }
    expect(g2).toContain('templates/host-conformance-result.md');
    expect(g2).toContain('templates/host-conformance-result.schema.json');
  });

  it('accepts actual-host and fixture-labelled results and keeps not-run distinct from pass', () => {
    expect(schemaErrors(result('actual-host'), hostSchema)).toEqual([]);
    expect(schemaErrors(result('reference-fixture-host'), hostSchema)).toEqual([]);
    expect(schemaErrors(result('memory-fixture-host', 'not-run (environment)'), hostSchema)).toEqual([]);
    const unlabelled = result('actual-host');
    delete unlabelled.subject;
    expect(schemaErrors(unlabelled, hostSchema)).not.toEqual([]);
    expect(schemaErrors(result('reference-host-as-actual'), hostSchema)).not.toEqual([]);
    expect(schemaErrors(result('actual-host', 'passed'), hostSchema)).not.toEqual([]);
    const incomplete = result('actual-host');
    delete (incomplete.steps as Record<string, unknown>)['crash-after-display'];
    expect(schemaErrors(incomplete, hostSchema)).not.toEqual([]);
    const unidentified = result('actual-host');
    (unidentified.host as Record<string, unknown>).binarySha256 = 'unknown';
    expect(schemaErrors(unidentified, hostSchema)).not.toEqual([]);
    expect(schemaErrors({ ...result('actual-host'), learnerNotes: 'x' }, hostSchema)).not.toEqual([]);
  });

  it('the JSON skeleton in the template does not validate until a real run fills it', () => {
    const markdown = read('docs/study-harness/templates/host-conformance-result.md');
    const skeleton = JSON.parse(markdown.slice(markdown.indexOf('```json') + 7, markdown.indexOf('```', markdown.indexOf('```json') + 7)));
    expect(Object.keys(skeleton.steps)).toEqual(STEP_IDS);
    expect(schemaErrors(skeleton, hostSchema).length).toBeGreaterThan(0);
  });
});

describe('G3 agent trial template (A57 preparation)', () => {
  it('external-gates.md G3 names the recorder, its schema and the log template; the log lists every step and repair kind', () => {
    const g3 = section('G3');
    for (const text of ['createTrialRecorder', 'templates/agent-trial-record.schema.json', 'templates/agent-trial-log.md', 'tests/agent/trial-recorder.test.ts']) expect(g3, text).toContain(text);
    const log = read('docs/study-harness/templates/agent-trial-log.md');
    for (const step of G3_STEPS) expect(log, step).toContain(`\`${step}\``);
    for (const repair of TRIAL_REPAIRS) expect(log, repair).toContain(`\`${repair}\``);
    expect(JSON.parse(read('docs/study-harness/templates/agent-trial-record.schema.json'))).toEqual(JSON.parse(JSON.stringify(AGENT_TRIAL_RECORD_SCHEMA)));
  });
});
