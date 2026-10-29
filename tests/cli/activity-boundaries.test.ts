/**
 * Static boundary of the activity authoring CLI (report §16, A09): the Node-side modules never load toolkit packages or
 * authored code as values. `@experiment-kit/*` appears there only in type positions; the toolkit reaches Node only
 * through the run-time bundle of activity-toolkit.ts (activity-loader.ts), and authored files only through esbuild's
 * parser into browser worker bundles. Browser-side entries are listed separately and never import Node built-ins.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE = path.resolve('packages/cli/src');
/** Bundled for the browser (page or worker) or for the Node toolkit facade; may import toolkit packages as values. */
const BUNDLED = new Set([
  'activity-fixtures.ts', 'activity-validation.ts', 'activity-policy.ts', 'activity-toolkit.ts', 'activity-harness.ts', 'activity-worker.ts', 'activity-capture.ts',
  'activity-page-support.ts', 'activity-preview-page.ts',
]);
const BROWSER = ['activity-fixtures.ts', 'activity-harness.ts', 'activity-worker.ts', 'activity-capture.ts', 'activity-page-support.ts', 'activity-preview-page.ts'];
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

interface Reference { specifier: string; typeOnly: boolean; dynamic: boolean }
function referencesOf(file: string): Reference[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Reference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: !!clause && (clause.isTypeOnly || (!clause.name && !!named?.length && named.every(element => element.isTypeOnly))), dynamic: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, dynamic: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push({ specifier: node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '<computed>', typeOnly: false, dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('activity CLI module boundaries', () => {
  const modules = readdirSync(SOURCE).filter(name => name.startsWith('activity-') && name.endsWith('.ts'));

  it('keeps @experiment-kit packages type-only in Node-side modules', () => {
    const nodeSide = modules.filter(name => !BUNDLED.has(name));
    expect(nodeSide).toEqual(expect.arrayContaining(['activity-commands.ts', 'activity-bundle.ts', 'activity-browser.ts', 'activity-files.ts', 'activity-loader.ts', 'activity-scaffold.ts', 'activity-archive.ts', 'activity-packet.ts', 'activity-preview.ts', 'activity-preview-assets.ts']));
    for (const name of nodeSide) {
      const values = referencesOf(path.join(SOURCE, name)).filter(item => item.specifier.startsWith('@experiment-kit/') && !item.typeOnly);
      expect(values, name).toEqual([]);
      // Node-side modules import only relative CLI modules, Node built-ins and third-party tools; never a bundled module as a value.
      const bundled = referencesOf(path.join(SOURCE, name)).filter(item => !item.typeOnly && BUNDLED.has(path.basename(item.specifier).replace(/\.js$/, '.ts')));
      expect(bundled, name).toEqual([]);
    }
  });

  it('loads code dynamically in Node only for the toolkit bundle', () => {
    const dynamic = modules.filter(name => !BUNDLED.has(name)).flatMap(name => referencesOf(path.join(SOURCE, name)).filter(item => item.dynamic).map(item => `${name}: ${item.specifier}`));
    expect(dynamic).toEqual(['activity-loader.ts: <computed>']);
    expect(readFileSync(path.join(SOURCE, 'activity-loader.ts'), 'utf8')).toMatch(/entryPoints: \[path\.join\(CLI_SOURCE, 'activity-toolkit\.ts'\)\]/);
  });

  it('keeps browser entries free of Node built-ins', () => {
    for (const name of BROWSER) {
      const builtins = referencesOf(path.join(SOURCE, name)).filter(item => NODE_BUILTINS.has(item.specifier));
      expect(builtins, name).toEqual([]);
    }
  });
});
