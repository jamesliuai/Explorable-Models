import { DocumentError, type Expression, type NumericValue, type ValueResult } from './types.js';
export const EXPRESSION_LIMITS = Object.freeze({ characters: 2048, nodes: 256, depth: 32, vectorLength: 256 });
export const EXPRESSION_FUNCTIONS = Object.freeze(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'abs', 'exp', 'log', 'log10', 'floor', 'ceil', 'round', 'sign', 'min', 'max', 'pow', 'clamp', 'hypot', 'vector', 'dot', 'norm', 'component', 'sum']);
export type ExpressionNode = {
    type: 'number';
    value: number;
} | {
    type: 'reference';
    name: string;
} | {
    type: 'unary';
    op: '+' | '-';
    value: ExpressionNode;
} | {
    type: 'binary';
    op: string;
    left: ExpressionNode;
    right: ExpressionNode;
} | {
    type: 'call';
    name: string;
    args: ExpressionNode[];
} | {
    type: 'vector';
    items: ExpressionNode[];
};
const arities: Record<string, [
    number,
    number
]> = { sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1], atan2: [2, 2], sqrt: [1, 1], abs: [1, 1], exp: [1, 1], log: [1, 1], log10: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 1], sign: [1, 1], min: [1, 32], max: [1, 32], pow: [2, 2], clamp: [3, 3], hypot: [1, 32], vector: [2, 256], dot: [2, 2], norm: [1, 1], component: [2, 2], sum: [1, 1] };
function fail(path: string, message: string): never { throw new DocumentError([{ code: 'EXPRESSION', path, message }]); }
export function parseExpression(expression: Expression, path = 'expression'): ExpressionNode {
    if (typeof expression === 'number') {
        if (!Number.isFinite(expression))
            fail(path, 'Expected a finite number.');
        return { type: 'number', value: expression };
    }
    if (Array.isArray(expression)) {
        if (expression.length < 2 || expression.length > EXPRESSION_LIMITS.vectorLength || expression.some(v => typeof v !== 'number' || !Number.isFinite(v)))
            fail(path, 'A vector needs 2–256 finite numeric components.');
        return { type: 'vector', items: expression.map(value => ({ type: 'number', value })) };
    }
    if (typeof expression !== 'string' || expression.length > EXPRESSION_LIMITS.characters)
        fail(path, 'Expression must be a bounded number, vector, or string.');
    // Every token is consumed. Dots are allowed only inside complete declared IDs, never as lookup operators.
    const tokens: string[] = [];
    let offset = 0;
    while (offset < expression.length) {
        const whitespace = /^\s+/.exec(expression.slice(offset));
        if (whitespace) {
            offset += whitespace[0].length;
            continue;
        }
        const match = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|\*\*|[+\-*/%^(),\[\]])/.exec(expression.slice(offset));
        if (!match)
            fail(path, `Unsupported token at character ${offset + 1}.`);
        tokens.push(match[0]);
        offset += match[0].length;
        if (tokens.length > 1024)
            fail(path, 'Expression token limit exceeded.');
    }
    let position = 0, count = 0;
    const add = (node: ExpressionNode) => { if (++count > EXPRESSION_LIMITS.nodes)
        fail(path, 'Expression node limit exceeded.'); return node; };
    function parse(min: number, depth: number): ExpressionNode {
        if (depth > EXPRESSION_LIMITS.depth)
            fail(path, 'Expression nesting limit exceeded.');
        const token = tokens[position++];
        let left: ExpressionNode;
        if (!token)
            fail(path, 'Expected an expression.');
        if (token === '+' || token === '-')
            left = add({ type: 'unary', op: token, value: parse(25, depth + 1) });
        else if (token === '(') {
            left = parse(0, depth + 1);
            if (tokens[position++] !== ')')
                fail(path, 'Expected a closing parenthesis.');
        }
        else if (token === '[') {
            const items: ExpressionNode[] = [];
            do {
                items.push(parse(0, depth + 1));
                if (items.length > EXPRESSION_LIMITS.vectorLength)
                    fail(path, 'Vector limit exceeded.');
            } while (tokens[position] === ',' && ++position);
            if (tokens[position++] !== ']')
                fail(path, 'Expected a closing bracket.');
            if (items.length < 2)
                fail(path, 'Vectors require at least two components.');
            left = add({ type: 'vector', items });
        }
        else if (/^(?:\d|\.\d)/.test(token)) {
            const value = Number(token);
            if (!Number.isFinite(value))
                fail(path, 'Number must be finite.');
            left = add({ type: 'number', value });
        }
        else if (/^[A-Za-z_]/.test(token)) {
            if (tokens[position] === '(') {
                if (!Object.hasOwn(arities, token))
                    fail(path, `Function '${token}' is not supported.`);
                position++;
                const args: ExpressionNode[] = [];
                if (tokens[position] !== ')')
                    do {
                        args.push(parse(0, depth + 1));
                    } while (tokens[position] === ',' && ++position);
                if (tokens[position++] !== ')')
                    fail(path, 'Expected a closing parenthesis.');
                const [low, high] = arities[token];
                if (args.length < low || args.length > high)
                    fail(path, `${token} requires ${low === high ? low : `${low}–${high}`} arguments.`);
                left = add({ type: 'call', name: token, args });
            }
            else
                left = add({ type: 'reference', name: token });
        }
        else
            fail(path, `Unexpected token '${token}'.`);
        while (position < tokens.length) {
            const op = tokens[position];
            const priority = op === '+' || op === '-' ? 10 : op === '*' || op === '/' || op === '%' ? 20 : op === '^' || op === '**' ? 30 : -1;
            if (priority < min)
                break;
            position++;
            left = add({ type: 'binary', op, left, right: parse(priority + (priority === 30 ? 0 : 1), depth + 1) });
        }
        return left;
    }
    const root = parse(0, 0);
    if (position !== tokens.length)
        fail(path, `Unexpected token '${tokens[position]}'.`);
    // Left associative expressions can be deep despite shallow parser recursion.
    function check(node: ExpressionNode, depth: number): void { if (depth > EXPRESSION_LIMITS.depth)
        fail(path, 'Expression tree depth exceeded.'); for (const child of children(node))
        check(child, depth + 1); }
    check(root, 0);
    return root;
}
function children(node: ExpressionNode): ExpressionNode[] { return node.type === 'binary' ? [node.left, node.right] : node.type === 'unary' ? [node.value] : node.type === 'call' ? node.args : node.type === 'vector' ? node.items : []; }
export function expressionReferences(node: ExpressionNode): string[] { const refs = new Set<string>(); const visit = (n: ExpressionNode) => { if (n.type === 'reference')
    refs.add(n.name); children(n).forEach(visit); }; visit(node); return [...refs]; }
const valid = (value: NumericValue): ValueResult => typeof value === 'number' ? Number.isFinite(value) ? { value, status: 'valid' } : { value: null, status: 'undefined', reason: 'The result is nonfinite.' } : value.every(Number.isFinite) ? { value, status: 'valid' } : { value: null, status: 'undefined', reason: 'A vector component is nonfinite.' };
const undefinedValue = (reason: string): ValueResult => ({ value: null, status: 'undefined', reason });
export function evaluateExpression(node: ExpressionNode, resolve: (name: string) => ValueResult): ValueResult {
    if (node.type === 'number')
        return valid(node.value);
    if (node.type === 'reference')
        return node.name === 'pi' ? valid(Math.PI) : node.name === 'e' ? valid(Math.E) : resolve(node.name);
    if (node.type === 'unary') {
        const v = evaluateExpression(node.value, resolve);
        return v.status === 'undefined' ? v : valid(Array.isArray(v.value) ? v.value.map(x => node.op === '-' ? -x : x) : node.op === '-' ? -(v.value as number) : v.value as number);
    }
    const nodes = node.type === 'binary' ? [node.left, node.right] : node.type === 'vector' ? node.items : node.args;
    const values = nodes.map(n => evaluateExpression(n, resolve));
    const missing = values.find(v => v.status === 'undefined');
    if (missing)
        return missing;
    const args = values.map(v => v.value as NumericValue);
    if (node.type === 'vector')
        return args.some(Array.isArray) ? undefinedValue('Vectors cannot contain nested vectors.') : valid(args as number[]);
    if (node.type === 'binary') {
        const [a, b] = args;
        if (Array.isArray(a) || Array.isArray(b)) {
            if ((node.op === '+' || node.op === '-') && Array.isArray(a) && Array.isArray(b) && a.length === b.length)
                return valid(a.map((v, i) => node.op === '+' ? v + b[i] : v - b[i]));
            if (node.op === '*' && Array.isArray(a) && typeof b === 'number')
                return valid(a.map(v => v * b));
            if (node.op === '*' && typeof a === 'number' && Array.isArray(b))
                return valid(b.map(v => a * v));
            if (node.op === '/' && Array.isArray(a) && typeof b === 'number')
                return b === 0 ? undefinedValue('Division by zero.') : valid(a.map(v => v / b));
            return undefinedValue('Incompatible vector operation.');
        }
        if ((node.op === '/' || node.op === '%') && b === 0)
            return undefinedValue('Division by zero.');
        switch (node.op) {
            case '+': return valid(a + b);
            case '-': return valid(a - b);
            case '*': return valid(a * b);
            case '/': return valid(a / b);
            case '%': return valid(a % b);
            case '^':
            case '**': return valid(a ** b);
        }
    }
    if (node.type !== 'call')
        return undefinedValue('Unsupported operation.');
    const [a, b, c] = args;
    if (node.name === 'vector')
        return args.some(Array.isArray) ? undefinedValue('Vectors cannot contain nested vectors.') : valid(args as number[]);
    if (node.name === 'dot')
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length ? valid(a.reduce((total, v, i) => total + v * b[i], 0)) : undefinedValue('dot requires equal length vectors.');
    if (node.name === 'norm')
        return Array.isArray(a) ? valid(Math.hypot(...a)) : undefinedValue('norm requires a vector.');
    if (node.name === 'sum')
        return Array.isArray(a) ? valid(a.reduce((total, v) => total + v, 0)) : undefinedValue('sum requires a vector.');
    if (node.name === 'component')
        return Array.isArray(a) && typeof b === 'number' && Number.isInteger(b) && b >= 0 && b < a.length ? valid(a[b]) : undefinedValue('Vector component index is outside its zero-based domain.');
    if (args.some(Array.isArray))
        return undefinedValue(`${node.name} requires scalar arguments.`);
    const x = a as number, y = b as number, z = c as number;
    if (node.name === 'tan' && Math.abs(Math.cos(x)) < 1e-14)
        return undefinedValue('Tangent is undefined at an odd multiple of π/2 (within floating-point resolution).');
    if (node.name === 'sqrt' && x < 0)
        return undefinedValue('Square root requires a nonnegative argument.');
    if ((node.name === 'log' || node.name === 'log10') && x <= 0)
        return undefinedValue('Logarithm requires a positive argument.');
    if ((node.name === 'asin' || node.name === 'acos') && Math.abs(x) > 1)
        return undefinedValue(`${node.name} requires an argument between -1 and 1.`);
    if (node.name === 'atan2' && x === 0 && y === 0)
        return undefinedValue('The angle of a zero vector is undefined.');
    if (node.name === 'clamp')
        return y > z ? undefinedValue('Clamp minimum exceeds maximum.') : valid(Math.max(y, Math.min(z, x)));
    if (node.name === 'pow')
        return valid(x ** y);
    if (node.name === 'min')
        return valid(Math.min(...args as number[]));
    if (node.name === 'max')
        return valid(Math.max(...args as number[]));
    if (node.name === 'hypot')
        return valid(Math.hypot(...args as number[]));
    if (node.name === 'atan2')
        return valid(Math.atan2(x, y));
    const fn = ({ sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log, log10: Math.log10, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign } as Record<string, (value: number) => number>)[node.name];
    return fn ? valid(fn(x)) : undefinedValue('Unsupported function.');
}
/** Deliberately small dimensional algebra. Display unit labels never perform conversions. */
export interface ExpressionType {
    size: number;
    dimension: Record<string, number>;
}
const namedDimensions: Record<string, Record<string, number>> = { dimensionless: {}, scalar: {}, '1': {}, length: { length: 1 }, time: { time: 1 }, mass: { mass: 1 }, angle: { angle: 1 }, area: { length: 2 }, volume: { length: 3 }, velocity: { length: 1, time: -1 }, speed: { length: 1, time: -1 }, acceleration: { length: 1, time: -2 }, frequency: { time: -1 }, force: { mass: 1, length: 1, time: -2 }, energy: { mass: 1, length: 2, time: -2 } };
export function parseDimension(value = 'dimensionless', path = 'dimension'): Record<string, number> {
    if (Object.hasOwn(namedDimensions, value))
        return { ...namedDimensions[value] };
    // Products and quotients of base dimensions, with integer powers; no inferred unit conversions.
    if (!/^(?:length|time|mass|angle)(?:\^-?\d{1,2})?(?:[*/](?:length|time|mass|angle)(?:\^-?\d{1,2})?)*$/.test(value))
        fail(path, `Unsupported dimension '${value}'. Use a documented dimension name or base-dimension product.`);
    const result: Record<string, number> = {};
    for (const match of value.matchAll(/([*/]?)(length|time|mass|angle)(?:\^(-?\d+))?/g))
        result[match[2]] = (result[match[2]] ?? 0) + (match[1] === '/' ? -1 : 1) * Number(match[3] ?? 1);
    return clean(result);
}
function clean(dim: Record<string, number>) { return Object.fromEntries(Object.entries(dim).filter(([, v]) => v !== 0)); }
function combine(a: Record<string, number>, b: Record<string, number>, sign = 1) { const dim = { ...a }; for (const [key, value] of Object.entries(b))
    dim[key] = (dim[key] ?? 0) + sign * value; return clean(dim); }
export function sameDimension(a: Record<string, number>, b: Record<string, number>) { return Object.keys({ ...a, ...b }).every(k => (a[k] ?? 0) === (b[k] ?? 0)); }
function isZeroLiteral(node: ExpressionNode): boolean { return node.type === 'number' && node.value === 0 || node.type === 'unary' && isZeroLiteral(node.value) || node.type === 'vector' && node.items.every(isZeroLiteral); }
export function inferExpressionType(node: ExpressionNode, resolve: (name: string) => ExpressionType, path: string): ExpressionType {
    const scalar = (dimension: Record<string, number> = {}): ExpressionType => ({ size: 1, dimension });
    const same = (a: ExpressionType, b: ExpressionType) => { if (a.size !== b.size || !sameDimension(a.dimension, b.dimension))
        fail(path, 'Incompatible dimensions or vector shapes.'); };
    if (node.type === 'number')
        return scalar();
    if (node.type === 'reference')
        return node.name === 'pi' || node.name === 'e' ? scalar() : resolve(node.name);
    if (node.type === 'unary')
        return inferExpressionType(node.value, resolve, path);
    if (node.type === 'vector' || node.type === 'call' && node.name === 'vector') {
        const items = (node.type === 'vector' ? node.items : node.args).map(n => inferExpressionType(n, resolve, path));
        if (items.some(v => v.size !== 1))
            fail(path, 'Nested vectors are unsupported.');
        const nodes = node.type === 'vector' ? node.items : node.args;
        const dimension = items.find((_, index) => !isZeroLiteral(nodes[index]))?.dimension ?? {};
        items.forEach((v, index) => { if (!isZeroLiteral(nodes[index]) && !sameDimension(v.dimension, dimension))
            fail(path, 'Incompatible vector component dimensions.'); });
        return { size: items.length, dimension };
    }
    if (node.type === 'binary') {
        const a = inferExpressionType(node.left, resolve, path), b = inferExpressionType(node.right, resolve, path);
        if (node.op === '+' || node.op === '-' || node.op === '%') {
            if (isZeroLiteral(node.left))
                a.dimension = b.dimension;
            if (isZeroLiteral(node.right))
                b.dimension = a.dimension;
            same(a, b);
            if (node.op === '%' && a.size !== 1)
                fail(path, 'Remainder requires scalars.');
            return a;
        }
        if (node.op === '*' || node.op === '/') {
            if (b.size !== 1 && (node.op === '/' || a.size !== 1))
                fail(path, 'Products require at least one scalar; divisors must be scalar.');
            return { size: Math.max(a.size, b.size), dimension: combine(a.dimension, b.dimension, node.op === '/' ? -1 : 1) };
        }
        if (a.size !== 1 || b.size !== 1 || !sameDimension(b.dimension, {}))
            fail(path, 'Powers require scalar values and a dimensionless exponent.');
        if (!sameDimension(a.dimension, {}) && (node.right.type !== 'number' || !Number.isInteger(node.right.value)))
            fail(path, 'A dimensional base requires a constant integer exponent.');
        return scalar(Object.fromEntries(Object.entries(a.dimension).map(([k, v]) => [k, v * (node.right.type === 'number' ? node.right.value : 1)])));
    }
    const args = node.args.map(n => inferExpressionType(n, resolve, path)), a = args[0], b = args[1];
    if (node.name === 'dot') {
        if (a.size < 2 || a.size !== b.size)
            fail(path, 'dot requires equal length vectors.');
        return scalar(combine(a.dimension, b.dimension));
    }
    if (node.name === 'norm' || node.name === 'sum') {
        if (a.size < 2)
            fail(path, `${node.name} requires a vector.`);
        return scalar(a.dimension);
    }
    if (node.name === 'component') {
        if (a.size < 2 || b.size !== 1 || !sameDimension(b.dimension, {}))
            fail(path, 'component requires a vector and a dimensionless scalar index.');
        return scalar(a.dimension);
    }
    if (args.some(v => v.size !== 1))
        fail(path, `${node.name} requires scalars.`);
    if (['sin', 'cos', 'tan'].includes(node.name)) {
        if (!sameDimension(a.dimension, {}) && !sameDimension(a.dimension, { angle: 1 }))
            fail(path, 'Trigonometric inputs must be dimensionless radians or angle.');
        return scalar();
    }
    if (['asin', 'acos', 'atan'].includes(node.name)) {
        if (!sameDimension(a.dimension, {}))
            fail(path, 'Inverse trigonometric inputs must be dimensionless.');
        return scalar({ angle: 1 });
    }
    if (node.name === 'atan2') {
        same(a, b);
        return scalar({ angle: 1 });
    }
    if (['exp', 'log', 'log10'].includes(node.name)) {
        if (!sameDimension(a.dimension, {}))
            fail(path, `${node.name} requires a dimensionless argument.`);
        return scalar();
    }
    if (node.name === 'sqrt')
        return scalar(Object.fromEntries(Object.entries(a.dimension).map(([k, v]) => [k, v / 2])));
    if (node.name === 'pow')
        return inferExpressionType({ type: 'binary', op: '^', left: node.args[0], right: node.args[1] }, resolve, path);
    if (['min', 'max', 'hypot', 'clamp'].includes(node.name)) {
        const dimension = args.find((_, index) => !isZeroLiteral(node.args[index]))?.dimension ?? {};
        args.forEach((v, index) => { if (isZeroLiteral(node.args[index]))
            v.dimension = dimension; });
        args.slice(1).forEach(v => same(a, v));
    }
    return node.name === 'sign' ? scalar() : a;
}
/** Conservatively detects sampled denominator/pole crossings; this is not general symbolic discontinuity analysis. */
export function crossesKnownDiscontinuity(node: ExpressionNode, before: (name: string) => ValueResult, after: (name: string) => ValueResult): boolean {
    let target: ExpressionNode | undefined, tangent = false;
    if (node.type === 'binary' && (node.op === '/' || node.op === '%'))
        target = node.right;
    if (node.type === 'binary' && (node.op === '^' || node.op === '**') && node.right.type === 'number' && node.right.value < 0)
        target = node.left;
    if (node.type === 'call' && node.name === 'pow' && node.args[1].type === 'number' && node.args[1].value < 0)
        target = node.args[0];
    if (node.type === 'call' && node.name === 'tan') {
        target = node.args[0];
        tangent = true;
    }
    if (target) {
        const a = evaluateExpression(target, before), b = evaluateExpression(target, after);
        if (a.status === 'valid' && b.status === 'valid' && typeof a.value === 'number' && typeof b.value === 'number') {
            const x = tangent ? Math.cos(a.value) : a.value, y = tangent ? Math.cos(b.value) : b.value;
            if (x === 0 || y === 0 || Math.sign(x) !== Math.sign(y))
                return true;
        }
    }
    return children(node).some(child => crossesKnownDiscontinuity(child, before, after));
}
/** Conservative primitive-operation bound including vector work and discontinuity checks. */
export function expressionOperationCost(node: ExpressionNode, referenceSize: (name: string) => number, sampling = false): number {
    function visit(current: ExpressionNode): {
        size: number;
        cost: number;
        crossing: number;
    } {
        if (current.type === 'number')
            return { size: 1, cost: 1, crossing: 1 };
        if (current.type === 'reference')
            return { size: referenceSize(current.name), cost: 1, crossing: 1 };
        const nested = children(current).map(visit), cost = nested.reduce((sum, item) => sum + item.cost, 0), crossing = nested.reduce((sum, item) => sum + item.crossing, 1);
        let size = current.type === 'vector' || current.type === 'call' && current.name === 'vector' ? nested.length : current.type === 'unary' ? nested[0].size : current.type === 'binary' ? Math.max(nested[0].size, nested[1].size) : 1;
        let work = size, extra = 0;
        if (current.type === 'call' && ['dot', 'norm', 'sum'].includes(current.name))
            work = nested[0].size * 2;
        if (current.type === 'binary' && ['/', '%'].includes(current.op))
            extra = nested[1].cost * 2;
        if (current.type === 'binary' && ['^', '**'].includes(current.op) && current.right.type === 'number' && current.right.value < 0)
            extra = nested[0].cost * 2;
        if (current.type === 'call' && (current.name === 'tan' || current.name === 'pow' && current.args[1].type === 'number' && current.args[1].value < 0))
            extra = nested[0].cost * 2;
        return { size, cost: cost + work, crossing: crossing + extra };
    }
    const result = visit(node);
    return result.cost + (sampling ? result.crossing : 0);
}
