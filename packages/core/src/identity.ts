import { ExperimentError } from './errors.js';
import { RUNTIME_VERSION, type Manifest, type ViewDefinition } from './types.js';
/** Stable JSON encoding: object keys are sorted; arrays preserve semantic order. */
export function canonicalJSON(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new ExperimentError('MODEL_ERROR', 'Cannot hash a nonfinite number.');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return '[' + value.map(canonicalJSON).join(',') + ']';
    if (typeof value === 'object')
        return '{' + Object.keys(value as object).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalJSON((value as Record<string, unknown>)[k])).join(',') + '}';
    throw new ExperimentError('MODEL_ERROR', 'Only JSON data can be canonically encoded.');
}
const constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
/** Small portable SHA-256, used identically in browsers and Node. */
export function sha256(text: string): string {
    const source = new TextEncoder().encode(text);
    const bytes = new Uint8Array(Math.ceil((source.length + 9) / 64) * 64);
    bytes.set(source);
    bytes[source.length] = 0x80;
    const data = new DataView(bytes.buffer);
    const bits = source.length * 8;
    data.setUint32(bytes.length - 8, Math.floor(bits / 4294967296));
    data.setUint32(bytes.length - 4, bits >>> 0);
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const words = new Uint32Array(64);
    for (let offset = 0; offset < bytes.length; offset += 64) {
        for (let j = 0; j < 16; j++)
            words[j] = data.getUint32(offset + j * 4);
        for (let j = 16; j < 64; j++) {
            const x = words[j - 15]!;
            const y = words[j - 2]!;
            words[j] = (words[j - 16]! + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[j - 7]! + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash as [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number
        ];
        for (let j = 0; j < 64; j++) {
            const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[j]! + words[j]!) >>> 0;
            const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        [a, b, c, d, e, f, g, h].forEach((v, i) => { hash[i] = (hash[i]! + v) >>> 0; });
    }
    return hash.map(v => v.toString(16).padStart(8, '0')).join('');
}
export function digest(value: unknown): string { return 'sha256:' + sha256(canonicalJSON(value)); }
export function definitionRevision(input: {
    manifest: Manifest;
    source: string;
    dependencyLock: string;
    views?: readonly ViewDefinition[];
    runtimeIdentity?: string;
}): string {
    return digest({ ...input, runtimeIdentity: input.runtimeIdentity ?? RUNTIME_VERSION });
}
export function createId(prefix: string): string {
    return prefix + '-' + (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}
export function clone<T>(value: T): T { return structuredClone(value); }
export function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value))
            deepFreeze(item);
    }
    return value;
}
