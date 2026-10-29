/**
 * Schema 2.0 document execution is an opt-in capability of the model layer (architecture D3, report §8.1, §16; F1 of
 * docs/study-harness/performance.md). A realm that has not called `enableDocumentExecution()` refuses document
 * executions with UNSUPPORTED_CAPABILITY — never interpreting them some other way — while kernel manifests are
 * unaffected; and a bundle of the kernel-only API does not contain the document compiler or interpreter.
 *
 * This file must not import a module that enables document execution before the first describe block runs (vitest
 * isolates test files, so other files' calls do not leak here).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  documentExecutionEnabled, documentModelRevision, enableDocumentExecution, evaluateRequest, ModelError, modelIdentity, validateManifest, type ModelExecution,
} from '../../packages/core/src/model/index';
import { allKernels, dropManifest, geometricManifest } from './support/model-fixtures';

const MODEL_ENTRY = fileURLToPath(new URL('../../packages/core/src/model/index.ts', import.meta.url));
const failureOf = (run: () => unknown): string[] => {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ModelError); return (error as ModelError).diagnostics.map(item => `${item.code} ${item.path}`); }
  throw new Error('Expected a ModelError.');
};

/** Code and contributing source files of a tree-shaken browser consumer of the model entry. */
async function bundleModel(contents: string): Promise<{ sources: string[]; code: string }> {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  const output = Object.values(result.metafile.outputs)[0]!;
  return {
    sources: Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file),
    code: result.outputFiles[0]!.text,
  };
}
const COMPILER = /packages\/core\/src\/declarative\/(validation|evaluation|schema|interaction|worker)\.ts$/;
const DOCUMENT_AGREEMENT = /packages\/core\/src\/model\/document-(manifest|units)\.ts$/;
const DOCUMENT_IDENTITY = /packages\/core\/src\/declarative\/model-projection\.ts$/;

describe('document execution is opt-in', () => {
  it('refuses document executions before enableDocumentExecution(), and leaves kernel manifests unaffected', () => {
    expect(documentExecutionEnabled()).toBe(false);
    expect(validateManifest(geometricManifest()).identity.digest).toMatch(/^sha256:/);
    const document = dropManifest();
    expect(failureOf(() => validateManifest(document))).toEqual(['UNSUPPORTED_CAPABILITY $.execution']);
    expect(failureOf(() => modelIdentity(document))).toEqual(['UNSUPPORTED_CAPABILITY $.execution.document']);
    expect(failureOf(() => documentModelRevision((document.execution as Extract<ModelExecution, { kind: 'document' }>).document))).toEqual(['UNSUPPORTED_CAPABILITY $.execution.document']);
    expect(failureOf(() => evaluateRequest({ manifest: document, params: { h: 10, g: 9.8 }, position: { kind: 'time', time: 0 } }, allKernels))).toEqual(['UNSUPPORTED_CAPABILITY $.execution']);
    const error = (() => { try { validateManifest(document); } catch (caught) { return caught as ModelError; } return null; })();
    expect(error?.diagnostics[0]?.recovery).toContain('enableDocumentExecution()');
  });

  it('validates, identifies and evaluates document executions once enabled', () => {
    expect(enableDocumentExecution()).toBe(true);
    expect(enableDocumentExecution()).toBe(true);
    expect(documentExecutionEnabled()).toBe(true);
    const { manifest, identity } = validateManifest(dropManifest());
    expect(identity.digest).toMatch(/^sha256:/);
    const data = evaluateRequest({ manifest, params: { h: 10, g: 9.8 }, position: { kind: 'time', time: 0 } }, allKernels);
    expect(data.position).toMatchObject({ kind: 'time', time: 0 });
  });

  it('keeps document agreement strict after opting in, including same-dimension scale disagreements', () => {
    enableDocumentExecution();
    const parameter = dropManifest();
    parameter.parameters.h!.unit = 'cm';
    expect(failureOf(() => validateManifest(parameter))).toContain('UNIT_MISMATCH $.execution.document.parameters.h.unit');
    const quantity = dropManifest();
    quantity.quantities.flight!.unit = 'ms';
    expect(failureOf(() => validateManifest(quantity))).toContain('UNIT_MISMATCH $.execution.document.quantities.flight.unit');
    const coordinate = dropManifest();
    coordinate.geometry.fall!.coordinates!.x = 'ms';
    expect(failureOf(() => validateManifest(coordinate))).toContain('UNIT_MISMATCH $.execution.document.series.fall.x');
  });
});

describe('the kernel-only model API does not bundle the document runtime', () => {
  it('excludes the schema 2.0 compiler and interpreter from a kernel-only bundle and includes them only with enableDocumentExecution', async () => {
    const kernelOnly = await bundleModel(`import { validateManifest, modelIdentity, createModelSession, createWorkerBudget, serveModelWorker, assembleFrame, checkParameters } from ${JSON.stringify(MODEL_ENTRY)};
      export const api = { validateManifest, modelIdentity, createModelSession, createWorkerBudget, serveModelWorker, assembleFrame, checkParameters };`);
    expect(kernelOnly.sources.some(file => /packages\/core\/src\/model\/manifest\.ts$/.test(file))).toBe(true);
    expect(kernelOnly.sources.some(file => /packages\/core\/src\/model\/protocol\.ts$/.test(file))).toBe(true);
    expect(kernelOnly.sources.some(file => /packages\/core\/src\/model\/geometry-units\.ts$/.test(file))).toBe(true);
    expect(kernelOnly.sources.filter(file => COMPILER.test(file))).toEqual([]);
    expect(kernelOnly.sources.filter(file => DOCUMENT_AGREEMENT.test(file))).toEqual([]);
    expect(kernelOnly.sources.filter(file => DOCUMENT_IDENTITY.test(file))).toEqual([]);
    // expressions.ts also supplies the kernel constraint parser. Its document type checker must still be removed.
    for (const name of ['inferExpressionType', 'documentManifestErrors', 'documentAgreementErrors', 'documentSeriesErrors', 'observedSeriesErrors', 'documentUnits'])
      expect(kernelOnly.code).not.toContain(`function ${name}(`);
    expect(kernelOnly.code).not.toContain('A dimensional base requires a constant integer exponent.');
    expect(kernelOnly.code).not.toContain('The expression combines values with different canonical unit scales without conversion.');
    expect(kernelOnly.code).not.toContain('function documentModelProjection(');
    const withDocuments = await bundleModel(`import { validateManifest, enableDocumentExecution } from ${JSON.stringify(MODEL_ENTRY)};
      enableDocumentExecution(); export const api = { validateManifest };`);
    expect(withDocuments.sources.some(file => /declarative\/validation\.ts$/.test(file))).toBe(true);
    expect(withDocuments.sources.some(file => /declarative\/evaluation\.ts$/.test(file))).toBe(true);
    expect(withDocuments.sources.filter(file => DOCUMENT_AGREEMENT.test(file))).toHaveLength(2);
    expect(withDocuments.sources.filter(file => DOCUMENT_IDENTITY.test(file))).toHaveLength(1);
    expect(withDocuments.code).toContain('The expression combines values with different canonical unit scales without conversion.');
    expect(withDocuments.code).toContain('A dimensional base requires a constant integer exponent.');
  });
});
