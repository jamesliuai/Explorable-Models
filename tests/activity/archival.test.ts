/**
 * Archival read-only representation (report §14, A49; G20/G69): when a verified artifact cannot be reopened (exact
 * template or model missing, content revoked, learner snapshot), the restore recovery names `archivalView`, which
 * describes the artifact's own records without evaluating or substituting a model. Learner and tutor views pass the
 * restricted-content leak scan; teacher and host views list the saved values. Fixture-host results with test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { archivalView, artifactIntegrity, createStudyHarnessAdapter, type ActivityArtifact, type ArchivalView } from '@experiment-kit/activity';
import { createInstalledCatalog } from '@experiment-kit/catalog';
import {
  enterExplore, guards, harness, manifest, okOf, op, open, presentationGuard, settled, template, type Harness, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

let disposers: (() => void)[] = [];
const make = (...args: Parameters<typeof harness>) => { const h = harness(...args); disposers.push(() => h.adapter.dispose()); return h; };
afterEach(() => { for (const dispose of disposers) dispose(); disposers = []; });

async function save(opened: Opened, kind: 'backup' | 'learner-snapshot' = 'backup'): Promise<ActivityArtifact> {
  const saved = await opened.control.save({ operationId: op('save'), kind });
  if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
  return saved.artifact;
}
/** A saved exploration with distinctive values: η = 0.6 committed, then a retained comparison, at n = 3. */
async function savedExploration(): Promise<{ h: Harness; opened: Opened; artifact: ActivityArtifact }> {
  const h = make();
  const opened = await open(h);
  await enterExplore(h, opened);
  okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.6 } }));
  okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Kept run' }));
  okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }));
  okOf(opened.learner.setCamera({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'landscape', camera: { kind: '2d', center: [1, 2], zoom: 2 } }));
  await settled(h);
  return { h, opened, artifact: await save(opened) };
}
function fresh(h: Harness, catalog: Parameters<typeof createInstalledCatalog>[0] | 'no-model') {
  const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
  const installed = catalog === 'no-model' ? { ...h.catalog, getModel: () => null } : createInstalledCatalog({ ...catalog, workerFactory: h.workers.factory });
  const adapter = createStudyHarnessAdapter({ catalog: installed, host });
  disposers.push(() => adapter.dispose());
  return adapter;
}
const viewOf = (raw: unknown, audience: ArchivalView['audience']): ArchivalView => {
  const result = archivalView(raw, { audience });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.view;
};
const HIDDEN_QUANTITIES = template.groups.filter(group => group.solutionBearing && group.kind === 'quantity').flatMap(group => group.members);
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
/** Restricted content of the quadratic template: hidden quantity labels and IDs, solution text, derivations, constraint text. */
const RESTRICTED = (() => {
  const hiddenGroups = template.groups.filter(group => group.solutionBearing);
  const quantityIds = hiddenGroups.filter(group => group.kind === 'quantity').flatMap(group => group.members);
  return [
    // Generic labels that also name visible values are excluded, as in disclosure.test.ts.
    ...quantityIds.map(id => manifest.quantities[id]!.label).filter(label => !['Position', 'Loss', 'Gradient', 'Regime'].includes(label)),
    ...template.equations.map(equation => equation.label), ...template.equations.map(equation => equation.plain.slice(0, 20)),
    ...template.content.filter(entry => entry.kind !== 'learner-copy').map(entry => entry.text.slice(0, 48)), manifest.constraints[0]!.message.slice(0, 48),
    ...template.stages.map(stage => stage.instruction.slice(0, 40)),
  ];
})();

describe('restore recoveries name the archival view (G20)', () => {
  it('a missing template version: UNSUPPORTED_ARTIFACT whose recovery names archivalView, which renders the saved record without any model', async () => {
    const { h, artifact } = await savedExploration();
    h.adapter.dispose('act-quadratic-1');
    const adapter = fresh(h, { include: ['function-derivative'] });
    const refused = await adapter.restore(artifact, { operationId: op(), hostSessionRevision: 1 });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.diagnostics).toMatchObject([{ code: 'UNSUPPORTED_ARTIFACT', path: '$.template' }]);
    expect(refused.diagnostics[0]!.recovery).toMatch(/archivalView\(artifact, \{ audience \}\)/);
    const view = viewOf(artifact, 'host');
    expect(view).toMatchObject({
      kind: 'archival-view', readOnly: true, audience: 'host', template: artifact.template, model: artifact.model,
      activity: { activityId: 'act-quadratic-1', stageId: 'explore-step', mode: 'approved', closed: false }, position: { kind: 'index', index: 3 },
      journal: { lastSequence: artifact.journal.cursor.lastSequence },
    });
    expect(view.parameters).toEqual([{ parameter: 'a', value: 2 }, { parameter: 'eta', value: 0.6 }, { parameter: 'x0', value: 4 }]);
    expect(view.comparisons).toEqual([{ label: 'Kept run', parameters: [{ parameter: 'a', value: 2 }, { parameter: 'eta', value: 0.6 }, { parameter: 'x0', value: 4 }], position: expect.any(Object) }]);
    expect(view.exposures.map(item => item.displayStatus)).toContain('displayed');
    expect(view.lines[0]).toMatch(/read-only record/);
    expect(view.lines.join(' ')).toContain('eta = 0.6');
  });

  it('a missing model: UNSUPPORTED_ARTIFACT naming archivalView; the archival view never needs the model', async () => {
    const { h, artifact } = await savedExploration();
    h.adapter.dispose('act-quadratic-1');
    const refused = await fresh(h, 'no-model').restore(artifact, { operationId: op(), hostSessionRevision: 1 });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.diagnostics).toMatchObject([{ code: 'UNSUPPORTED_ARTIFACT', path: '$.model' }]);
    expect(refused.diagnostics[0]!.recovery).toMatch(/archivalView/);
    expect(viewOf(artifact, 'teacher').model).toEqual(artifact.model);
  });

  it('revoked content: CONTENT_REVOKED naming archivalView; the record keeps the exact saved identities (no substitution)', async () => {
    const { h, artifact } = await savedExploration();
    h.adapter.dispose('act-quadratic-1');
    const revoked = await fresh(h, { revocations: [{ kind: 'template', id: template.templateId, version: template.version, reason: 'Withdrawn.' }] }).restore(artifact, { operationId: op(), hostSessionRevision: 1 });
    if (revoked.ok) throw new Error('expected a refusal');
    expect(revoked.diagnostics).toMatchObject([{ code: 'CONTENT_REVOKED' }]);
    expect(revoked.diagnostics[0]!.recovery).toMatch(/archivalView\(artifact, \{ audience \}\)/);
    const view = viewOf(artifact, 'learner');
    expect(view.template).toEqual(artifact.template);
    expect(view.artifact.digest).toMatch(/^sha256:/);
  });

  it('a learner snapshot restore names archivalView, and the learner view lists the values the snapshot recorded as visible', async () => {
    const { h, opened } = await savedExploration();
    const snapshot = await save(opened, 'learner-snapshot');
    const refused = await h.adapter.restore(snapshot, { operationId: op(), hostSessionRevision: 1 });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', path: '$.kind' });
    expect(refused.diagnostics[0]!.recovery).toMatch(/archivalView/);
    const view = viewOf(snapshot, 'learner');
    expect(view.artifact.kind).toBe('learner-snapshot');
    expect(view.parameters!.map(item => item.parameter)).toEqual(Object.keys(snapshot.scientific.params).sort());
  });
});

describe('audience filtering of the archival view (G69)', () => {
  it('learner and tutor views of a backup withhold parameter values and pass the restricted-content leak scan', async () => {
    const { artifact } = await savedExploration();
    for (const audience of ['learner', 'tutor'] as const) {
      const view = viewOf(artifact, audience);
      expect(view.parameters, audience).toBeNull();
      expect(view.comparisons.every(item => item.parameters === null), audience).toBe(true);
      expect(view.notes, audience).toEqual([]);
      expect(view.exposures.every(item => item.uncertainty === null), audience).toBe(true);
      const text = JSON.stringify(view);
      for (const restricted of RESTRICTED) expect(text, `${audience}: ${restricted}`).not.toContain(restricted);
      // No string value names a hidden quantity (keys are the view's own field names).
      for (const value of strings(view)) expect(HIDDEN_QUANTITIES, `${audience}: ${value}`).not.toContain(value);
      expect(text, audience).not.toContain('0.6');
      for (const receipt of artifact.exposures.map(item => item.receiptId)) expect(text, audience).not.toContain(receipt);
    }
    expect(viewOf(artifact, 'host').parameters).not.toBeNull();
  });

  it('refuses what it cannot verify and never interprets an unreadable record', async () => {
    const { artifact } = await savedExploration();
    const tampered = { ...structuredClone(artifact), scientific: { ...artifact.scientific, params: { ...artifact.scientific.params, eta: 1.9 } } };
    const corrupt = archivalView(tampered, { audience: 'host' });
    expect(corrupt.ok).toBe(false);
    expect(corrupt.ok ? [] : corrupt.diagnostics.map(item => item.code)).toContain('INTEGRITY_FAILURE');
    const future = archivalView({ ...structuredClone(artifact), schemaVersion: '2.0' }, { audience: 'host' });
    expect(future.ok ? null : future.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', recovery: expect.stringMatching(/original bytes/) });
    expect(archivalView('{"truncated":', { audience: 'host' }).ok).toBe(false);
    expect(archivalView(artifact, { audience: 'parent' as never })).toMatchObject({ ok: false, diagnostics: [{ code: 'INVALID_INPUT', path: '$.audience' }] });
    // Bytes and text read like the parsed value; a recomputed integrity manifest does not hide a forged learner snapshot.
    expect(viewOf(new TextEncoder().encode(JSON.stringify(artifact)), 'host').artifact.artifactId).toBe(artifact.artifactId);
    const { integrity: _integrity, ...body } = structuredClone(artifact);
    const forged = { ...body, kind: 'learner-snapshot' as const };
    expect(archivalView({ ...forged, integrity: artifactIntegrity(forged) }, { audience: 'learner' }).ok).toBe(false);
  });
});
