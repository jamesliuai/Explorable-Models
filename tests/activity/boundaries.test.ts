/**
 * Package boundary scan (A01): a static import graph built with the TypeScript parser from each package's entry files,
 * following relative imports (including `new URL('./x', import.meta.url)` worker/asset references) wherever they lead.
 * Every package named by the architecture now exists, so every row is active: a row whose entries match no file fails
 * (a removed or renamed package must not turn its boundary into a silent pass). Add rows here when new entries land.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

interface BoundaryRule {
  name: string;
  /** Entry files or `**` globs relative to the root. A row with no matching file fails. */
  entries: string[];
  /** Forbidden bare specifiers: exact package names (subpaths included) or prefixes ending in `*`. */
  forbidden: string[];
  /** Root-relative directories that no reached file may resolve into. */
  forbiddenPaths: string[];
  /** Bare specifiers that are allowed only through a dynamic `import()` (lazy chunks). */
  lazyOnly?: string[];
  /** Bare specifiers that may be imported for types only. */
  typeOnly?: string[];
  /** Code patterns (comments removed) that indicate DOM rendering or other forbidden behaviour. */
  forbiddenCode?: { pattern: RegExp; reason: string }[];
  /** A visualization package (report §16): its forbidden list includes every specifier of NOT_IN_VISUALIZATION. */
  visualization?: true;
}

const NODE_BUILTINS = ['node:*', ...builtinModules.filter(name => !name.startsWith('_'))];
const PROVIDER_SDKS = ['openai', '@anthropic-ai/*', '@google/*', '@google-cloud/*', '@mistralai/*', 'cohere-ai', 'ollama', '@aws-sdk/client-bedrock*'];
const UI = ['react', 'react-dom', 'three', '@tauri-apps/*'];
/** Credential stores and keychains (report §16: the visualization packages never hold or return provider keys). */
const CREDENTIAL_STORES = ['keytar', 'keychain', '@napi-rs/keyring', 'keyring', '@aspect/keyring', 'node-keytar', 'cross-keychain', 'electron', 'dotenv', '@1password/*', '@azure/keyvault-*', '@aws-sdk/client-secrets-manager', '@google-cloud/secret-manager'];
/**
 * Third-party filesystem and local-database libraries (report §16: the visualization packages import no filesystem
 * library; Node's own `fs`, `path` and the rest are NODE_BUILTINS). The host owns every file and the durable store.
 */
const FILESYSTEM_LIBRARIES = [
  'fs-extra', 'graceful-fs', 'memfs', 'unionfs', 'fs-jetpack', 'jsonfile', 'write-file-atomic', 'proper-lockfile', 'chokidar', 'glob', 'fast-glob', 'globby',
  'rimraf', 'mkdirp', 'make-dir', 'del', 'tmp', 'tempy', 'browserfs', '@zenfs/*', 'better-sqlite3', 'sqlite3', '@tauri-apps/plugin-fs',
];
/**
 * Report §16, verbatim scope: "The visualization packages must not import Tauri APIs, filesystem libraries, provider
 * clients or credential stores." Every visualization row forbids all four categories (Node built-ins are the
 * filesystem and process APIs of Node itself).
 */
const NOT_IN_VISUALIZATION = ['@tauri-apps/*', ...NODE_BUILTINS, ...FILESYSTEM_LIBRARIES, ...PROVIDER_SDKS, ...CREDENTIAL_STORES];
/** Browser storage: the host's store is the only authoritative learning record (report §14), so no second database. */
const BROWSER_STORAGE = [{ pattern: /\b(localStorage|sessionStorage|indexedDB|IDBFactory|openDatabase)\b/, reason: 'browser storage' }];
/** Network calls: the agent package is transport-neutral; the host owns every channel and provider call. */
const NETWORK = [{ pattern: /\b(fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(|sendBeacon)/, reason: 'network access' }];
const DOM_RENDERING = [
  { pattern: /\bdocument\s*\.\s*(createElement|body|getElementById|querySelector|head)\b/, reason: 'DOM rendering' },
  { pattern: /\.(innerHTML|outerHTML)\b/, reason: 'HTML injection' },
  { pattern: /\b(createRoot|hydrateRoot|ReactDOM)\b/, reason: 'React rendering' },
];

const BOUNDARIES: BoundaryRule[] = [
  {
    name: 'core is pure (no UI, native, filesystem, providers or higher packages)',
    entries: ['packages/core/src/**/*.ts'],
    visualization: true,
    forbidden: [...UI, ...NOT_IN_VISUALIZATION, '@explorable-models/player*', '@explorable-models/activity', '@explorable-models/catalog', '@explorable-models/agent', '@explorable-models/cli'],
    forbiddenPaths: ['packages/player', 'packages/player-3d', 'packages/activity', 'packages/catalog', 'packages/agent', 'packages/cli'],
    forbiddenCode: BROWSER_STORAGE,
  },
  {
    name: 'activity adapter is provider-neutral, DOM-free and catalogue-injected',
    entries: ['packages/activity/src/**/*.ts'],
    visualization: true,
    forbidden: [...UI, ...NOT_IN_VISUALIZATION, '@explorable-models/catalog', '@explorable-models/player*', '@explorable-models/agent', '@explorable-models/cli'],
    forbiddenPaths: ['packages/player', 'packages/player-3d', 'packages/catalog', 'packages/agent', 'packages/cli'],
    forbiddenCode: [...DOM_RENDERING, ...BROWSER_STORAGE],
  },
  {
    name: 'host conformance kit (@explorable-models/activity/conformance) is plain TypeScript: no Node, DOM, native, UI, network or storage code, so it runs in Node, a browser and a WebView',
    entries: ['packages/activity/src/conformance/**/*.ts'],
    visualization: true,
    forbidden: [...UI, ...NOT_IN_VISUALIZATION, '@explorable-models/catalog', '@explorable-models/player*', '@explorable-models/agent', '@explorable-models/cli'],
    forbiddenPaths: ['packages/player', 'packages/player-3d', 'packages/catalog', 'packages/agent', 'packages/cli'],
    forbiddenCode: [...DOM_RENDERING, ...BROWSER_STORAGE, ...NETWORK],
  },
  {
    name: 'catalogue holds data and pure kernels only',
    entries: ['packages/catalog/src/**/*.ts'],
    visualization: true,
    forbidden: [...UI, ...NOT_IN_VISUALIZATION, '@explorable-models/player*', '@explorable-models/agent', '@explorable-models/cli'],
    forbiddenPaths: ['packages/player', 'packages/player-3d', 'packages/agent', 'packages/cli'],
    forbiddenCode: BROWSER_STORAGE,
  },
  {
    name: 'learner surface loads 3D and math lazily and never imports authoring, CLI or native code',
    entries: ['packages/player/src/activity/**/*.ts', 'packages/player/src/activity/**/*.tsx'],
    visualization: true,
    forbidden: ['three', ...NOT_IN_VISUALIZATION, 'playwright', '@playwright/*', '@explorable-models/cli', '@explorable-models/agent', '@explorable-models/player-3d', 'katex'],
    lazyOnly: ['@explorable-models/player-3d', 'katex', 'three'],
    forbiddenPaths: ['packages/cli', 'packages/agent', 'packages/player-3d'],
    forbiddenCode: BROWSER_STORAGE,
  },
  {
    name: 'legacy 2D player entry (@explorable-models/player) imports no Tauri, filesystem, provider, credential, authoring or CLI code',
    entries: ['packages/player/src/public.ts'],
    visualization: true,
    forbidden: [...NOT_IN_VISUALIZATION, 'playwright', '@playwright/*', '@explorable-models/cli', '@explorable-models/agent', '@explorable-models/player-3d'],
    forbiddenPaths: ['packages/cli', 'packages/agent', 'packages/player-3d'],
    forbiddenCode: BROWSER_STORAGE,
  },
  {
    name: 'spatial renderer depends on core types only',
    entries: ['packages/player-3d/src/**/*.ts', 'packages/player-3d/src/**/*.tsx'],
    visualization: true,
    forbidden: [...NOT_IN_VISUALIZATION, '@explorable-models/activity', '@explorable-models/catalog', '@explorable-models/player', '@explorable-models/agent', '@explorable-models/cli'],
    typeOnly: ['@explorable-models/core*'],
    forbiddenPaths: ['packages/activity', 'packages/catalog', 'packages/player', 'packages/agent', 'packages/cli'],
    forbiddenCode: BROWSER_STORAGE,
  },
  {
    name: 'agent tools and relays are provider-neutral: no provider clients, credential stores, native, UI or network code',
    entries: ['packages/agent/src/**/*.ts'],
    forbidden: [...UI, ...NODE_BUILTINS, ...FILESYSTEM_LIBRARIES, ...PROVIDER_SDKS, ...CREDENTIAL_STORES, '@explorable-models/catalog', '@explorable-models/player*', '@explorable-models/cli'],
    forbiddenPaths: ['packages/catalog', 'packages/player', 'packages/player-3d', 'packages/cli'],
    forbiddenCode: [...DOM_RENDERING, ...BROWSER_STORAGE, ...NETWORK],
  },
];

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------
const posix = (path: string): string => path.split(sep).join('/');
const matches = (specifier: string, pattern: string): boolean =>
  pattern.endsWith('*') ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern || specifier.startsWith(`${pattern}/`);

/** Expands `dir/**\/*.ext` globs (the only form used) relative to `root`. */
function expand(root: string, pattern: string): string[] {
  const marker = pattern.indexOf('/**/');
  if (marker < 0) return existsSync(join(root, pattern)) ? [join(root, pattern)] : [];
  const base = join(root, pattern.slice(0, marker));
  const suffix = pattern.slice(marker + 4).replace(/^\*/, '');
  const walk = (directory: string): string[] => !existsSync(directory) ? [] : readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(suffix) && !path.endsWith('.d.ts') ? [path] : [];
  });
  return walk(base);
}

interface ImportRef { specifier: string; dynamic: boolean; typeOnly: boolean }
function importsOf(file: string, text: string): ImportRef[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: ImportRef[] = [];
  const literal = (node: ts.Node | undefined): string | null => node && ts.isStringLiteralLike(node) ? node.text : null;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every(element => element.isTypeOnly)));
      const specifier = literal(node.moduleSpecifier);
      if (specifier) found.push({ specifier, dynamic: false, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) found.push({ specifier, dynamic: false, typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literal(node.moduleReference.expression);
      if (specifier) found.push({ specifier, dynamic: false, typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literal(node.argument.literal);
      if (specifier) found.push({ specifier, dynamic: false, typeOnly: true });
    } else if (ts.isCallExpression(node)) {
      const specifier = literal(node.arguments[0]);
      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push({ specifier, dynamic: true, typeOnly: false });
      else if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require') found.push({ specifier, dynamic: false, typeOnly: false });
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2) {
      const specifier = literal(node.arguments[0]);
      const base = node.arguments[1]!;
      if (specifier?.startsWith('.') && ts.isPropertyAccessExpression(base) && ts.isMetaProperty(base.expression)) found.push({ specifier, dynamic: false, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function resolveRelative(from: string, specifier: string): string | null {
  const target = resolve(dirname(from), specifier);
  const candidates = [target, target.replace(/\.(m?js|jsx)$/, '.ts'), target.replace(/\.(m?js|jsx)$/, '.tsx'), `${target}.ts`, `${target}.tsx`, join(target, 'index.ts'), join(target, 'index.tsx')];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const stripComments = (file: string, text: string): string =>
  ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));

function scanBoundary(root: string, rule: BoundaryRule): { files: number; violations: string[] } {
  const queue = rule.entries.flatMap(entry => expand(root, entry));
  const seen = new Set<string>();
  const violations: string[] = [];
  const forbiddenDirectories = rule.forbiddenPaths.map(path => join(root, path) + sep);
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const where = posix(relative(root, file));
    if (forbiddenDirectories.some(directory => file.startsWith(directory))) { violations.push(`${where}: reached a forbidden package directory`); continue; }
    if (!/\.(tsx?|m?js)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const { specifier, dynamic, typeOnly } of importsOf(file, text)) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = resolveRelative(file, specifier);
        if (!target) { violations.push(`${where}: unresolved relative import ${specifier}`); continue; }
        if (forbiddenDirectories.some(directory => target.startsWith(directory))) violations.push(`${where}: imports ${specifier} inside a forbidden package`);
        else if (target.startsWith(root)) queue.push(target);
        continue;
      }
      const forbidden = rule.forbidden.find(pattern => matches(specifier, pattern));
      const lazy = dynamic && (rule.lazyOnly ?? []).some(pattern => matches(specifier, pattern));
      const typesOnly = typeOnly && (rule.typeOnly ?? []).some(pattern => matches(specifier, pattern));
      if (forbidden && !lazy) violations.push(`${where}: ${dynamic ? 'dynamically ' : ''}imports forbidden ${specifier}`);
      else if (rule.typeOnly && (rule.typeOnly).some(pattern => matches(specifier, pattern)) && !typesOnly) violations.push(`${where}: imports ${specifier} for values; only types are allowed`);
    }
    if (rule.forbiddenCode) {
      const code = stripComments(file, text);
      for (const { pattern, reason } of rule.forbiddenCode) if (pattern.test(code)) violations.push(`${where}: ${reason} (${pattern.source})`);
    }
  }
  return { files: seen.size, violations };
}

describe('package boundaries (A01)', () => {
  for (const rule of BOUNDARIES) {
    it(rule.name, () => {
      // A row may list a .ts and a .tsx glob; at least one of them must match.
      expect(rule.entries.some(entry => expand(repositoryRoot, entry).length > 0), `no entry of '${rule.name}' matches a file`).toBe(true);
      const { files, violations } = scanBoundary(repositoryRoot, rule);
      expect(files).toBeGreaterThan(0);
      expect(violations).toEqual([]);
    });
  }

  it('the scanner detects forbidden imports, escaping relative imports, worker URLs and DOM rendering', () => {
    const root = mkdtempSync(join(tmpdir(), 'boundary-scan-'));
    try {
      const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
      write('packages/pure/src/index.ts', [
        "// import 'react' in a comment is ignored",
        "import type { Thing } from './types.js';",
        "export * from './helper.js';",
        "export const lazy = () => import('three');",
        "export const worker = () => new Worker(new URL('./worker.js', import.meta.url));",
      ].join('\n'));
      write('packages/pure/src/types.ts', 'export interface Thing { id: string }');
      write('packages/pure/src/helper.ts', "import { readFileSync } from 'node:fs';\nimport { leak } from '../../ui/src/view.js';\nexport const x = () => document.createElement('div');");
      write('packages/pure/src/worker.ts', "import OpenAI from 'openai';\nexport default OpenAI;");
      write('packages/ui/src/view.ts', 'export const leak = 1;');
      const rule: BoundaryRule = { name: 'synthetic', entries: ['packages/pure/src/index.ts'], forbidden: ['react', 'three', 'node:*', 'openai'], forbiddenPaths: ['packages/ui'], lazyOnly: ['three'], forbiddenCode: DOM_RENDERING };
      const { files, violations } = scanBoundary(root, rule);
      expect(files).toBe(4);
      expect(violations.sort()).toEqual([
        'packages/pure/src/helper.ts: DOM rendering (\\bdocument\\s*\\.\\s*(createElement|body|getElementById|querySelector|head)\\b)',
        'packages/pure/src/helper.ts: imports ../../ui/src/view.js inside a forbidden package',
        'packages/pure/src/helper.ts: imports forbidden node:fs',
        'packages/pure/src/worker.ts: imports forbidden openai',
      ]);
      expect(scanBoundary(root, { ...rule, lazyOnly: [] }).violations).toContain('packages/pure/src/index.ts: dynamically imports forbidden three');
      expect(scanBoundary(root, { name: 'types', entries: ['packages/pure/src/types.ts'], forbidden: [], forbiddenPaths: [], typeOnly: ['./never'] }).violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the storage pattern finds localStorage, sessionStorage and indexedDB use in code but not in comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'boundary-storage-'));
    try {
      const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
      write('packages/pure/src/index.ts', ["// never writes localStorage or indexedDB", "export * from './a.js';", "export * from './b.js';", "export * from './c.js';", "export * from './d.js';"].join('\n'));
      write('packages/pure/src/a.ts', "export const save = (text: string) => localStorage.setItem('k', text);");
      write('packages/pure/src/b.ts', "export const read = () => window.sessionStorage.getItem('k');");
      write('packages/pure/src/c.ts', "export const open = () => indexedDB.open('db', 1);");
      write('packages/pure/src/d.ts', '/* sessionStorage is not used here */ export const clean = 1;');
      const { files, violations } = scanBoundary(root, { name: 'storage', entries: ['packages/pure/src/index.ts'], forbidden: [], forbiddenPaths: [], forbiddenCode: BROWSER_STORAGE });
      expect(files).toBe(5);
      expect(violations.map(item => item.split(':')[0]).sort()).toEqual(['packages/pure/src/a.ts', 'packages/pure/src/b.ts', 'packages/pure/src/c.ts']);
      // Every visualization row and the agent row carry the pattern.
      for (const rule of BOUNDARIES) expect(rule.forbiddenCode ?? [], rule.name).toEqual(expect.arrayContaining(BROWSER_STORAGE));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the agent row rejects a provider SDK, credential store, native API, filesystem or network call added to packages/agent/src', () => {
    const agent = BOUNDARIES.find(rule => rule.entries.includes('packages/agent/src/**/*.ts'))!;
    expect(agent).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'boundary-agent-'));
    try {
      const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
      // A clean copy of the real entry shape passes the real row.
      write('packages/agent/src/index.ts', "export * from './tools.js';");
      write('packages/agent/src/tools.ts', "import { sha256 } from '@explorable-models/core';\nimport type { ToolOperation } from '@explorable-models/activity';\nexport const digest = (text: string) => sha256(text);");
      expect(scanBoundary(root, agent).violations).toEqual([]);
      const cases: [string, string, RegExp][] = [
        ["import OpenAI from 'openai';\nexport const client = new OpenAI();", 'openai', /imports forbidden openai/],
        ["import Anthropic from '@anthropic-ai/sdk';\nexport default Anthropic;", 'anthropic', /imports forbidden @anthropic-ai\/sdk/],
        ["import keytar from 'keytar';\nexport const key = () => keytar.getPassword('svc', 'acct');", 'keytar', /imports forbidden keytar/],
        ["import { invoke } from '@tauri-apps/api/core';\nexport const call = () => invoke('get_key');", 'tauri', /imports forbidden @tauri-apps\/api\/core/],
        ["import { readFileSync } from 'node:fs';\nexport const read = () => readFileSync('.env', 'utf8');", 'fs', /imports forbidden node:fs/],
        ["export const send = (body: string) => fetch('https://api.example/v1', { method: 'POST', body });", 'fetch', /network access/],
        ["export const keep = (text: string) => localStorage.setItem('transcript', text);", 'storage', /browser storage/],
        ["export const load = () => import('@explorable-models/catalog');", 'catalog', /dynamically imports forbidden @explorable-models\/catalog/],
      ];
      for (const [code, name, expected] of cases) {
        write('packages/agent/src/tools.ts', code);
        const { violations } = scanBoundary(root, agent);
        expect(violations.join('\n'), name).toMatch(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('every visualization package row forbids Tauri APIs, filesystem libraries, provider clients and credential stores (report §16, R25)', () => {
    const rows = BOUNDARIES.filter(rule => rule.visualization);
    // The visualization packages: core, activity (and its conformance kit), catalogue, the learner surface and the legacy
    // 2D player entry of @explorable-models/player, and the spatial renderer.
    const covered = (glob: string) => rows.some(rule => rule.entries.includes(glob));
    for (const glob of ['packages/core/src/**/*.ts', 'packages/activity/src/**/*.ts', 'packages/activity/src/conformance/**/*.ts', 'packages/catalog/src/**/*.ts',
      'packages/player/src/activity/**/*.ts', 'packages/player/src/public.ts', 'packages/player-3d/src/**/*.ts']) expect(covered(glob), glob).toBe(true);
    for (const rule of rows) expect(rule.forbidden, rule.name).toEqual(expect.arrayContaining(NOT_IN_VISUALIZATION));
    for (const category of [['keytar', '@napi-rs/keyring', 'dotenv'], ['fs-extra', 'graceful-fs', 'memfs'], ['openai'], ['@tauri-apps/*']]) {
      for (const name of category) expect(NOT_IN_VISUALIZATION, name).toContain(name);
    }
  });

  it('a credential-store, filesystem-library, provider or Tauri import added to any visualization package fails its row (sabotage self-test, R25)', () => {
    const rows = BOUNDARIES.filter(rule => rule.visualization);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    const sabotage: [string, RegExp][] = [
      ["import keytar from 'keytar';\nexport const key = () => keytar.getPassword('svc', 'acct');", /imports forbidden keytar/],
      ["import { Entry } from '@napi-rs/keyring';\nexport const entry = new Entry('svc', 'acct');", /imports forbidden @napi-rs\/keyring/],
      ["import 'dotenv/config';\nexport const configured = true;", /imports forbidden dotenv\/config/],
      ["import fs from 'fs-extra';\nexport const read = () => fs.readJson('/tmp/x.json');", /imports forbidden fs-extra/],
      ["import fs from 'graceful-fs';\nexport const read = () => fs.readFileSync('x');", /imports forbidden graceful-fs/],
      ["import { vol } from 'memfs';\nexport const files = vol;", /imports forbidden memfs/],
      ["import Database from 'better-sqlite3';\nexport const db = () => new Database('study.db');", /imports forbidden better-sqlite3/],
      ["import { readFileSync } from 'node:fs';\nexport const read = () => readFileSync('x');", /imports forbidden node:fs/],
      ["import { invoke } from '@tauri-apps/api/core';\nexport const call = () => invoke('get_key');", /imports forbidden @tauri-apps\/api\/core/],
      ["import { readTextFile } from '@tauri-apps/plugin-fs';\nexport const read = () => readTextFile('x');", /imports forbidden @tauri-apps\/plugin-fs/],
      ["import OpenAI from 'openai';\nexport const client = () => new OpenAI();", /imports forbidden openai/],
      ["export const later = () => import('keytar');", /dynamically imports forbidden keytar/],
    ];
    for (const rule of rows) {
      const root = mkdtempSync(join(tmpdir(), 'boundary-visualization-'));
      try {
        // One entry file matching the row's first entry pattern, holding the sabotage import.
        const entry = rule.entries[0]!.replace(/\*\*\/\*(\.tsx?)$/, 'sabotage$1');
        const write = (text: string) => { mkdirSync(dirname(join(root, entry)), { recursive: true }); writeFileSync(join(root, entry), text); };
        write("import type { Thing } from '@explorable-models/core';\nexport const clean = (thing: Thing) => thing;");
        expect(scanBoundary(root, rule).violations.filter(item => /forbidden/.test(item)), `${rule.name}: control`).toEqual([]);
        for (const [code, expected] of sabotage) {
          write(code);
          const { files, violations } = scanBoundary(root, rule);
          expect(files, rule.name).toBe(1);
          expect(violations.join('\n'), `${rule.name}: ${code.split('\n')[0]}`).toMatch(expected);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
