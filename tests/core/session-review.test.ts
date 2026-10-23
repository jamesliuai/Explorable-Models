/** Automated adversarial review by a separate implementation agent; not human/security certification. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisualizationSession } from '../../packages/core/src/declarative-session.js';
import { createPreset } from '../../packages/core/src/presets.js';
import { evaluateDocument } from '../../packages/core/src/declarative/evaluation.js';
import type { MutationGuard, VisualizationSession, VisualizationDocument, DocumentEvaluator } from '../../packages/core/src/declarative/types.js';
const sessions: VisualizationSession[] = [];
let operation = 0;
const guard = (session: VisualizationSession): MutationGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, ...(session.getState().run && { expectedRunId: session.getState().run!.id }), operationId: `review-${++operation}` });
async function setup(document: VisualizationDocument = createPreset('supplied-data'), evaluator?: DocumentEvaluator) { const session = await createVisualizationSession({ evaluator: evaluator ?? { evaluate: async (request) => evaluateDocument(request), dispose() { } } }); sessions.push(session); const candidate = await session.createCandidate(document, guard(session)); await session.commitCandidate(candidate.id, guard(session)); return session; }
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers(); });
describe('automated independent session boundary review', () => {
    it('updates dataset display metadata on the committed frame while preserving scientific run', async () => {
        const session = await setup(), before = session.getState();
        const dataset = structuredClone(before.document!.datasets!.measurements);
        dataset.columns[1].label = 'Revised observed response';
        dataset.description = 'Revised display description';
        const candidate = await session.reviseCandidate([{ op: 'set', collection: 'datasets', id: 'measurements', value: dataset }], guard(session));
        await session.commitCandidate(candidate.id, guard(session));
        expect(session.getState().run).toBe(before.run);
        expect(session.getState().frame!.datasets.measurements.columns[1].label).toBe('Revised observed response');
        const reopened = await setup();
        await reopened.restoreDocument(session.exportDocument(), guard(reopened));
        expect(reopened.getState().frame).toEqual(session.getState().frame);
    });
    it('clears selection when a presentation edit removes the selected semantic ID', async () => {
        const session = await setup(createPreset('projectile'));
        session.select('projectile', guard(session));
        const before = session.getState();
        const mark = structuredClone(before.document!.views[0].marks!.find(mark => mark.id === 'body')!);
        mark.semanticId = 'renamed-projectile';
        const candidate = await session.reviseCandidate([{ op: 'setMark', viewId: 'scene', mark }], guard(session));
        await session.commitCandidate(candidate.id, guard(session));
        expect(session.getState().run).toBe(before.run);
        expect(session.getState().selection).toBeNull();
        const reopened = await setup();
        await expect(reopened.restoreDocument(session.exportDocument(), guard(reopened))).resolves.toBeDefined();
    });
    it('rejects pending parameter/seek completion after disposal even if a trusted test evaluator ignores cancellation', async () => {
        let held = false, release!: () => void;
        const session = await setup(createPreset('projectile'), { evaluate: async (request) => { if (held)
                await new Promise<void>(resolve => { release = resolve; }); return evaluateDocument(request); }, dispose() { } });
        held = true;
        const pending = session.seek(.2, guard(session));
        const rejection = expect(pending).rejects.toThrow(/disposed/);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        session.dispose();
        release();
        await rejection;
        expect(session.getState().status).toBe('disposed');
        expect(session.getState().frame).toBeNull();
    });
    it('keeps restore atomic if a comparison fails validation after the accepted document evaluated', async () => {
        const source = await setup(createPreset('projectile'));
        await source.setParameters({ vx: 5 }, guard(source));
        const artifact = source.exportDocument();
        artifact.comparisons[0].run.time = 100;
        const target = await setup(), before = target.getState();
        await expect(target.restoreDocument(artifact, guard(target))).rejects.toThrow(/outside/);
        expect(target.getState().run).toBe(before.run);
        expect(target.getState().document).toBe(before.document);
    });
});
describe('artifact retention budget review', () => {
    it('can reopen every artifact it exports even after retaining large valid documents', async () => {
        const document = createPreset('wave');
        document.assumptions = Array.from({ length: 64 }, () => 'a'.repeat(4000));
        document.limitations = Array.from({ length: 64 }, () => 'b'.repeat(3400));
        const source = await setup(document);
        for (let index = 0; index < 9; index++)
            await source.setParameters({ amplitude: index % 2 + 1 }, guard(source));
        const artifact = source.exportDocument(), target = await setup();
        await expect(target.restoreDocument(artifact, guard(target))).resolves.toBeDefined();
    });
});
