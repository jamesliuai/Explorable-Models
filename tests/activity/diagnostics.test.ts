import { describe, expect, it } from 'vitest';
import { MODEL_RECOVERIES, ModelError, modelError, validateKernelOutput, type ModelManifest } from '../../packages/core/src/model/index.js';
import { DIAGNOSTIC_CODES } from '../../packages/activity/src/schemas.js';
import { MODEL_CODE_MAP, fromModelDiagnostics } from '../../packages/activity/src/diagnostics.js';
import { validateRecord } from '../../packages/activity/src/validator.js';
import { event, quadraticManifest } from '../../packages/activity/fixtures-src/exemplars.js';

const failed = (code: string) => event('operation.failed', 60, { operation: 'navigate', code, recoverable: true, path: '$.reply' });
const caught = (run: () => unknown): ModelError => { try { run(); } catch (error) { if (error instanceof ModelError) return error; throw error; } throw new Error('Expected a ModelError.'); };

describe('model-layer diagnostics in the activity vocabulary', () => {
  it('knows every code the model layer can produce, without falling back', () => {
    const sentinel = 'CAPTURE_REJECTED';
    for (const code of Object.keys(MODEL_RECOVERIES)) {
      const [mapped] = fromModelDiagnostics([{ code, path: '$', message: 'x' }], sentinel);
      expect(mapped!.code, code).not.toBe(sentinel);
      expect(DIAGNOSTIC_CODES, code).toContain(mapped!.code);
    }
    expect(MODEL_CODE_MAP).toEqual({ WORKER_PROTOCOL: 'WORKER_ERROR' });
  });

  it('presents a worker protocol violation as a worker error that the journal accepts', () => {
    // A real protocol failure: kernel output that does not match the manifest.
    const error = caught(() => validateKernelOutput(quadraticManifest as ModelManifest, { kind: 'index', index: 0, maxIndex: 1000 }, { quantities: {}, geometry: {} }));
    expect(error.code).toBe('WORKER_PROTOCOL');
    const [mapped] = fromModelDiagnostics(error.diagnostics);
    expect(mapped).toEqual({ ...error.diagnostics[0], code: 'WORKER_ERROR' });
    expect(validateRecord('study-harness.interaction-event', failed(mapped!.code)).ok).toBe(true);
    // The unmapped core code is outside the stable vocabulary, so an event carrying it is rejected.
    expect(validateRecord('study-harness.interaction-event', failed('WORKER_PROTOCOL')).ok).toBe(false);
  });

  it('keeps path, message and recovery, passes activity codes through and maps unknown codes to the fallback', () => {
    const items = modelError('CONSTRAINT_VIOLATION', '$.constraints.step-product', 'Bound exceeded.', 'Lower η.').diagnostics;
    expect(fromModelDiagnostics(items)).toEqual([{ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.step-product', message: 'Bound exceeded.', recovery: 'Lower η.' }]);
    expect(fromModelDiagnostics([{ code: 'EVALUATION', path: '$.document', message: 'Invalid expression.' }])).toEqual([{ code: 'INVALID_INPUT', path: '$.document', message: 'Invalid expression.' }]);
    expect(fromModelDiagnostics([{ code: 'LIMIT', path: '$', message: 'Too many.' }], 'RESOURCE_LIMIT')[0]!.code).toBe('RESOURCE_LIMIT');
  });
});
