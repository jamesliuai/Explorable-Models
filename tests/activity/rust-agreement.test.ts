import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateRecord } from '../../packages/activity/src/validator.js';
import type { SchemaName } from '../../packages/activity/src/schemas.js';
import { repositoryRoot, rustDecisions } from './support/rust.js';

const fixtureRoot = join(repositoryRoot, 'packages/activity/fixtures/contracts');
const walk = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

describe('TypeScript and Rust contract validators agree (A02)', () => {
  it('reach the same decision as each other and as the declared expectation for every shared fixture', () => {
    const rust = rustDecisions();
    const files = walk(fixtureRoot).filter(path => path.endsWith('.json')).map(path => relative(fixtureRoot, path).split('\\').join('/')).sort();
    expect(rust.map(decision => decision.file).sort()).toEqual(files);
    expect(files.length).toBeGreaterThanOrEqual(26 * 8);
    const disagreements: string[] = [];
    for (const decision of rust) {
      const fixture = JSON.parse(readFileSync(join(fixtureRoot, decision.file), 'utf8')) as { contract: SchemaName; expect: 'valid' | 'invalid'; value: unknown };
      const typescript = validateRecord(fixture.contract, fixture.value).ok;
      expect(decision.contract).toBe(fixture.contract);
      expect(decision.expect).toBe(fixture.expect);
      if (typescript !== decision.valid) disagreements.push(`${decision.file}: TypeScript valid=${typescript}, Rust valid=${decision.valid}`);
      else if (typescript !== (fixture.expect === 'valid')) disagreements.push(`${decision.file}: both validators say valid=${typescript}, fixture expects ${fixture.expect}`);
    }
    expect(disagreements).toEqual([]);
  }, 900_000);
});
