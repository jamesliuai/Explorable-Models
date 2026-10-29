/**
 * TEST-ONLY operation meter for the installed kernels (report §8.1 "maximum work", G36). It compiles a kernel module's
 * own source with a TypeScript transformer that counts, at run time, every evaluated operation of the kernel's code:
 * each binary operator (arithmetic, bitwise, shift, comparison, logical), each unary or update operator, each compound
 * assignment, each call or `new`, and each loop iteration (as the loop's condition or an explicit count for `for…of`).
 * Built-in functions (Math.*, BigInt arithmetic on large operands, Array methods) count as one operation per call; work
 * inside them is not counted — the declared `maxOperations` bounds this abstract count, documented in
 * docs/study-harness/authoring.md. The instrumented module is a separate copy; the installed kernel is never modified.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { KernelInput, KernelOutput, ModelKernel } from '../../../packages/core/src/model/index';

const COUNTED_BINARY = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);
const METER = '__ekWork';

function counter(context: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
  const f = context.factory;
  const tick = () => f.createCallExpression(f.createIdentifier(METER), undefined, []);
  const counted = (expression: ts.Expression) => f.createParenthesizedExpression(f.createCommaListExpression([tick(), expression]));
  const visit = (node: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(node, visit, context);
    if (ts.isBinaryExpression(visited) && COUNTED_BINARY.has(visited.operatorToken.kind)) return counted(visited);
    if ((ts.isPrefixUnaryExpression(visited) || ts.isPostfixUnaryExpression(visited))) return counted(visited);
    if ((ts.isCallExpression(visited) || ts.isNewExpression(visited)) && !(ts.isIdentifier(visited.expression) && visited.expression.text === METER)) return counted(visited);
    if (ts.isForOfStatement(visited) || ts.isForInStatement(visited)) {
      const body = ts.isBlock(visited.statement) ? visited.statement.statements : [visited.statement];
      const block = f.createBlock([f.createExpressionStatement(tick()), ...body], true);
      return ts.isForOfStatement(visited) ? f.updateForOfStatement(visited, visited.awaitModifier, visited.initializer, visited.expression, block) : f.updateForInStatement(visited, visited.initializer, visited.expression, block);
    }
    return visited;
  };
  return source => ts.visitEachChild(source, visit, context);
}

export interface MeteredKernel { kernel: ModelKernel; measure(input: KernelInput): { operations: number; output: KernelOutput } }

/** Compiles `sourceFile` (a kernel module) with the operation meter and returns its kernel `exportName`. */
export async function meteredKernel(sourceFile: string, exportName: string): Promise<MeteredKernel> {
  const source = readFileSync(sourceFile, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: false },
    transformers: { before: [counter] }, fileName: sourceFile,
  });
  const directory = mkdtempSync(join(tmpdir(), 'ek-work-'));
  const file = join(directory, 'kernel.mjs');
  writeFileSync(file, `let __ekOps = 0;\nconst ${METER} = () => { __ekOps++; };\nexport const __ekRead = () => __ekOps;\nexport const __ekReset = () => { __ekOps = 0; };\n${outputText}`);
  try {
    const module = await import(pathToFileURL(file).href) as Record<string, unknown> & { __ekRead(): number; __ekReset(): void };
    const kernel = module[exportName] as ModelKernel;
    if (!kernel || typeof kernel.evaluate !== 'function') throw new Error(`${sourceFile} has no kernel export ${exportName}.`);
    return {
      kernel,
      measure(input) { module.__ekReset(); const output = kernel.evaluate(input); return { operations: module.__ekRead(), output }; },
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
