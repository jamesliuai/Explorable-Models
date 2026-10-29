/** A legacy/custom compiler registry cannot silently bypass document/manifest agreement. */
import { expect, it } from 'vitest';
import { evaluateCompiledDocument } from '../../packages/core/src/declarative/evaluation';
import { compileDocument, normalizeDocument } from '../../packages/core/src/declarative/validation';
import { installDocumentExecution } from '../../packages/core/src/model/document-support';
import { ModelError } from '../../packages/core/src/model/errors';
import { documentModelRevision, modelIdentity } from '../../packages/core/src/model/identity';
import { validateManifest } from '../../packages/core/src/model/manifest';
import { dropDocument, dropManifest, geometricManifest } from './support/model-fixtures';

it('refuses a document when installed compiler/evaluator support omits manifest validation; kernels remain usable', () => {
  installDocumentExecution({ normalize: normalizeDocument, compile: compileDocument, evaluate: evaluateCompiledDocument });
  const invalid = dropManifest();
  invalid.parameters.h!.unit = 'cm';
  try { validateManifest(invalid); throw new Error('A partial registry must not accept a document manifest'); } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).diagnostics).toMatchObject([{ code: 'UNSUPPORTED_CAPABILITY', path: '$.execution' }]);
    expect((error as ModelError).diagnostics[0]!.message).toContain('manifest validation is not enabled');
  }
  expect(validateManifest(geometricManifest()).identity.digest).toMatch(/^sha256:/);
  for (const run of [() => documentModelRevision(dropDocument()), () => modelIdentity(dropManifest())]) {
    try { run(); throw new Error('A partial registry must not identify a document'); } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).diagnostics).toMatchObject([{ code: 'UNSUPPORTED_CAPABILITY', path: '$.execution.document' }]);
      expect((error as ModelError).diagnostics[0]!.message).toContain('model identity is not enabled');
    }
  }
});
