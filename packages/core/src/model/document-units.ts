/** Coherent unit scales for schema 2.0 model documents. Labels never convert the numbers an expression computes. */
import type { ExpressionNode } from '../declarative/expressions.js';
import type { Diagnostic } from '../declarative/types.js';
import type { CompiledDocument } from '../declarative/validation.js';
import { diagnostic } from './errors.js';
import { UNIT_IDS, UNITS } from './units.js';

export const sameScale = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0
  && Math.abs(a - b) <= 1e-12 * Math.max(a, b);
const statedScale = (text: string | undefined): number => {
  const unit = UNIT_IDS.find(id => text === id || text === UNITS[id].label);
  // Unstated units use coherent base units. Unsupported labels are diagnosed by manifest/document agreement.
  return unit === undefined ? 1 : UNITS[unit].factorToBase;
};
const zero = (node: ExpressionNode): boolean => node.type === 'number' ? node.value === 0
  : node.type === 'unary' ? zero(node.value) : node.type === 'vector' && node.items.every(zero);

export function documentUnits(compiled: CompiledDocument) {
  const scales: Record<string, number | null> = Object.create(null);
  const errors: Diagnostic[] = [];
  const refused = (path: string, message: string): null => {
    if (!errors.some(item => item.path === path)) errors.push(diagnostic('UNIT_MISMATCH', path, message,
      'Use coherent canonical units in the document expressions. Display labels never convert values.'));
    return null;
  };
  const coherent = (nodes: ExpressionNode[], values: (number | null)[], path: string): number | null => {
    if (values.some(value => value === null)) return null;
    const scale = values[nodes.findIndex(node => !zero(node))] ?? 1;
    return nodes.every((node, i) => zero(node) || sameScale(values[i]!, scale)) ? scale
      : refused(path, 'The expression combines values with different canonical unit scales without conversion.');
  };
  function expressionScale(node: ExpressionNode, path: string, variable?: string): number | null {
    if (node.type === 'number') return 1;
    if (node.type === 'reference') return ['pi', 'e', 'time', variable].includes(node.name) ? 1 : scales[node.name] ?? null;
    if (node.type === 'unary') return expressionScale(node.value, path, variable);
    if (node.type === 'vector') return coherent(node.items, node.items.map(item => expressionScale(item, path, variable)), path);
    if (node.type === 'binary') {
      const a = expressionScale(node.left, path, variable), b = expressionScale(node.right, path, variable);
      if (a === null || b === null) return null;
      if (['+', '-', '%'].includes(node.op)) return coherent([node.left, node.right], [a, b], path);
      if (node.op === '*') return checkedScale(a * b, path);
      if (node.op === '/') return checkedScale(a / b, path);
      if (!sameScale(b, 1)) return refused(path, 'An exponent must be an unscaled pure number.');
      if (node.right.type === 'number') return checkedScale(a ** node.right.value, path);
      return sameScale(a, 1) ? 1 : refused(path, 'A scaled base requires a constant exponent to determine its unit.');
    }
    const args = node.args.map(item => expressionScale(item, path, variable));
    if (args.some(value => value === null)) return null;
    const a = args[0]!;
    if (node.name === 'pow') return expressionScale({ type: 'binary', op: '^', left: node.args[0]!, right: node.args[1]! }, path, variable);
    if (node.name === 'dot') return checkedScale(a * args[1]!, path);
    if (node.name === 'sqrt') return checkedScale(Math.sqrt(a), path);
    if (node.name === 'component' && !sameScale(args[1]!, 1)) return refused(path, 'A component index must be an unscaled pure number.');
    if (['vector', 'min', 'max', 'hypot', 'clamp', 'atan2'].includes(node.name)) {
      const scale = coherent(node.args, args, path);
      return scale === null ? null : node.name === 'atan2' ? 1 : scale;
    }
    if (['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log10'].includes(node.name))
      return sameScale(a, 1) ? 1 : refused(path, 'This function requires coherent base units (radians for angles), without implicit scale conversion.');
    return node.name === 'sign' ? 1 : a;
  }
  const checkedScale = (scale: number | null, path: string) => scale === null || Number.isFinite(scale) && scale > 0 ? scale
    : refused(path, 'The expression unit scale is outside the representable range.');
  for (const [id, spec] of Object.entries(compiled.document.parameters)) scales[id] = statedScale(spec.unit);
  for (const id of compiled.order) {
    const spec = compiled.document.quantities[id]!;
    const path = `$.execution.document.quantities.${id}.expression`;
    scales[id] = checkedScale(typeof spec.expression === 'string' ? expressionScale(compiled.expressions[id]!, path) : statedScale(spec.unit), path);
  }
  if (compiled.end) {
    const path = '$.execution.document.time.end';
    const scale = expressionScale(compiled.end, path);
    if (scale !== null && !sameScale(scale, 1)) refused(path, 'The document timeline is in seconds; its end expression has another time scale.');
  }
  return { scales, errors, expressionScale: (node: ExpressionNode, path: string, variable?: string) => checkedScale(expressionScale(node, path, variable), path) };
}
