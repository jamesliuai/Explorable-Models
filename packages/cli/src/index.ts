import { parseArgs } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProject, TOOLKIT_ROOT } from './compiler.js';
import { BrowserSession } from './browser.js';
import { createCoordinator, connect, saveConnection } from './coordinator.js';
import { exportArtifact } from './artifacts.js';
import { CliError, SOURCE_FILES, ensureEmptyDestination, exists, readBounded, readJSON, writeJSON } from './files.js';
import { serveMcp } from './mcp.js';
import { DocumentBrowserSession } from './document-browser.js';
import { serveDocumentMcp } from './document-mcp.js';
import { openService } from './service.js';
import { serveStatic } from './server.js';
import type { CheckReport, Snapshot } from '../../core/src/types.js';

const HELP = `Explorable Models 0.2.0-preview.1 — reproducible interactive explanations

Usage: experiment-kit <command> [directory] [options]

  init <directory>      Copy a standalone example's editable source
  dev [directory]       Build and serve an authenticated local preview
  check [directory]     Validate schema, imports, bundle, and default model frame
  verify [directory]    Run authored quantitative checks in a browser worker
  export [directory]    Build an offline static artifact with source and checks
  capture [directory]   Save a pinned player PNG and frame identity sidecar
  describe [directory]  Print contract, quantities, and capabilities as JSON
  inspect [directory]   Print the exact active frame (or --session live player)
  sample [directory]    Evaluate isolated parameters and times as JSON
  command [directory]   Apply a version-guarded JSON command to --session
  checkpoint [directory] Save or restore a portable state with --session
  compare [directory]   Compare retained runs in an explicit --session
  activate [directory]  Check then activate source in --session with --args guards
  sessions              List browser sessions for --session connection file
  mcp [directory]       Serve legacy source-project tools over local stdio MCP
  mcp-document          Author a blank declarative v2 session through stdio MCP
  serve <directory>     Serve an exported artifact locally

Options:
  --template <name>     rolling, linear-map (default), base-rates, riemann-sums, oscillator
  --out <path>          Export directory, PNG, or JSON output path
  --zip                 Also write an export ZIP
  --port <number>       Loopback preview/server port (default: available port)
  --session <path>      Connection JSON written by dev (contains a local token)
  --session-id <id>     Explicit player when several previews are open
  --args <json>         Operation arguments, e.g. '{"times":[0,1]}'
  --snapshot <path>     Restore a snapshot before inspection/capture
  --width <number>      Capture viewport width (320–4096; default 1440)
  --height <number>     Capture viewport height (320–4096; default 1000)
  --help                Show this help

Trusted local source only. Candidate JavaScript runs in browser workers;
candidate package scripts, build hooks, and Vite configuration never execute.
`;
function numeric(value: string | undefined, name: string): number | undefined { if (value === undefined) return undefined; const result = Number(value); if (!Number.isFinite(result) || !Number.isInteger(result)) throw new CliError('INVALID_PARAMETER', `${name} must be an integer.`); return result; }
function decodeArgs(value: string | undefined): Record<string, unknown> { if (!value) return {}; let result: unknown; try { result = JSON.parse(value); } catch { throw new CliError('INVALID_PARAMETER', '--args must contain a valid JSON object.'); } if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CliError('INVALID_PARAMETER', '--args must contain an object.'); return result as Record<string, unknown>; }
async function stopOnSignal(cleanup: () => Promise<void>): Promise<void> { await new Promise<void>(resolve => { const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); }; process.once('SIGINT', done); process.once('SIGTERM', done); }); await cleanup(); }
async function emit(result: unknown, output?: string): Promise<void> { if (output) { await mkdir(path.dirname(path.resolve(output)), { recursive: true }); await writeJSON(path.resolve(output), result); } process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: 'boolean' }, template: { type: 'string' }, out: { type: 'string' }, zip: { type: 'boolean' }, port: { type: 'string' }, session: { type: 'string' }, 'session-id': { type: 'string' }, args: { type: 'string' }, snapshot: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' } } });
  const command = positionals[0];
  if (!command || values.help) { process.stdout.write(HELP); return; }
  const directory = path.resolve(positionals[1] ?? '.');
  const args = decodeArgs(values.args);
  const port = numeric(values.port, 'port');
  if (port !== undefined && (port < 0 || port > 65535)) throw new CliError('INVALID_PARAMETER', 'port must be between 0 and 65535.');
  if (command === 'mcp-document') {
    if (positionals[1] || values.session) throw new CliError('INVALID_PARAMETER', 'mcp-document creates a blank session and takes no source directory or legacy connection.');
    const browser = await DocumentBrowserSession.create();
    try {
      const server = await serveDocumentMcp(browser);
      try { await new Promise<void>(resolve => { const done = () => { process.stdin.off('end', done); process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); }; process.stdin.once('end', done); process.once('SIGINT', done); process.once('SIGTERM', done); }); }
      finally { await server.close(); }
    } finally { await browser.close(); }
    return;
  }
  if (command === 'init') {
    if (!positionals[1]) throw new CliError('INVALID_PARAMETER', 'init needs a destination directory.');
    const template = values.template ?? 'linear-map';
    if (!['rolling','linear-map','base-rates','riemann-sums','oscillator'].includes(template)) throw new CliError('INVALID_PARAMETER', `Unknown template: ${template}`);
    const templateDirectory = path.join(TOOLKIT_ROOT, 'examples', template);
    const contents: Record<string, string> = {};
    for (const name of SOURCE_FILES) if (await exists(path.join(templateDirectory, name))) contents[name] = await readBounded(path.join(templateDirectory, name));
    if (!contents['experiment.json'] || !contents['model.ts']) throw new CliError('INVALID_SOURCE', `Template ${template} is incomplete.`);
    await ensureEmptyDestination(directory);
    for (const [name, text] of Object.entries(contents)) await writeFile(path.join(directory, name), text.replaceAll(/(['"])\.\.\/\.\.\/packages\/core\/src\/(?:types|index)\1/g, "'@experiment-kit/core'"));
    await writeFile(path.join(directory, 'README.md'), `# ${template} experiment\n\nEdit model.ts for mathematics, experiment.json for the public contract, views.json for semantic bindings, checks.ts for author assertions, and model.md for assumptions.\n\nRun from your Explorable Models installation:\n\n\`\`\`sh\nexperiment-kit dev ${JSON.stringify(directory)}\nexperiment-kit verify ${JSON.stringify(directory)}\nexperiment-kit export ${JSON.stringify(directory)} --out ./exported-experiment --zip\n\`\`\`\n\nUse exact run and definition guards from inspect before agent mutations. Candidate models execute in a dedicated browser worker, not the CLI process. Only trusted local authoring is supported.\n`);
    await emit({ directory, template, files: Object.keys(contents), next: `experiment-kit dev ${JSON.stringify(directory)}` }); return;
  }
  if (command === 'serve') {
    const server = await serveStatic(directory, { port }); process.stdout.write(`Explorable Models: ${server.url}\n`); await stopOnSignal(() => server.close()); return;
  }
  if (command === 'sessions') { if (!values.session) throw new CliError('INVALID_PARAMETER', 'sessions requires --session.'); await emit(await (await connect(values.session)).sessions()); return; }
  if (command === 'dev') {
    const project = await compileProject(directory, { player: true });
    let coordinator: Awaited<ReturnType<typeof createCoordinator>> | undefined;
    const connectionFile = path.resolve(values.session ?? path.join(directory, '.experiment-kit-session.json'));
    try {
      const validation = await BrowserSession.create(project); let report: unknown;
      try { report = await validation.checked('verify'); } finally { await validation.close(); }
      if (!(report as CheckReport).passed) throw new CliError('CHECK_FAILED', 'Author checks failed. Fix the candidate before previewing.');
      coordinator = await createCoordinator(project.directory, port); await saveConnection(connectionFile, coordinator.connection);
      process.stdout.write(`Explorable Models preview: ${coordinator.server.url}\nLocal agent connection: ${connectionFile}\nSource revision: ${project.definition.definitionRevision}\nEdit source, then use activate with expected revision/run guards; failed candidates preserve this preview.\n`);
      await stopOnSignal(async () => { await coordinator!.close(); await project.dispose(); await rm(connectionFile, { force: true }); });
    } catch (error) { await coordinator?.close(); await project.dispose(); throw error; }
    return;
  }
  if (['check','verify','export'].includes(command)) {
    const project = await compileProject(directory, { player: command === 'export' });
    let browser: BrowserSession | undefined;
    try {
      browser = await BrowserSession.create(project);
      if (command === 'check') { const frame = await browser.checked('inspect'); await emit({ passed: true, categories: ['build','schema','default-model-frame'], definitionRevision: project.definition.definitionRevision, inspection: frame, modelReview: project.definition.manifest.review, learnerEvidence: 'not_evaluated' }, values.out); }
      else {
        const report = await browser.checked('verify') as CheckReport;
        if (command === 'verify') { await emit(report, values.out); if (!report.passed) process.exitCode = 1; }
        else { if (!values.out) throw new CliError('INVALID_PARAMETER', 'export requires --out <directory>.'); await emit(await exportArtifact(project, path.resolve(values.out), report, values.zip)); }
      }
    } finally { await browser?.close(); await project.dispose(); }
    return;
  }
  if (!['mcp','describe','inspect','sample','command','checkpoint','compare','capture','activate'].includes(command)) throw new CliError('INVALID_COMMAND', `Unknown command: ${command}`, 'Run experiment-kit --help.');
  if (['command','compare','activate'].includes(command) && !values.session) throw new CliError('INVALID_PARAMETER', `${command} requires --session so it targets a persistent player.`);
  const service = await openService(directory, values.session);
  try {
    if (command === 'mcp') { const server = await serveMcp(service); await new Promise<void>(resolve => { process.stdin.once('end', resolve); process.once('SIGINT', resolve); process.once('SIGTERM', resolve); }); await server.close(); return; }
    if (values.snapshot && command !== 'capture') {
      const state = await service.request('state', {}, values['session-id']) as { activeRunId: string; run: { version: number } } | { error: unknown };
      if ('error' in state) { await emit(state); process.exitCode = 1; return; }
      const result = await service.request('command', { type: 'restore', snapshot: await readJSON(values.snapshot), expectedRunVersion: state.run.version, expectedActiveRunId: state.activeRunId }, values['session-id']);
      if (result && typeof result === 'object' && 'error' in result) { await emit(result); process.exitCode = 1; return; }
    }
    let result: unknown;
    if (command === 'capture') result = await service.capture({ output: values.out ?? 'experiment-capture.png', width: numeric(values.width, 'width'), height: numeric(values.height, 'height'), snapshot: values.snapshot ? await readJSON(values.snapshot) as Snapshot : undefined, sessionId: values['session-id'] });
    else if (command === 'activate') result = await service.activate({ ...args, directory, sessionId: values['session-id'] });
    else result = await service.request(command, args, values['session-id']);
    await emit(result, command === 'capture' ? undefined : values.out);
    if (result && typeof result === 'object' && 'error' in result) process.exitCode = 1;
  } finally { await service.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${JSON.stringify({ error: error instanceof CliError ? error.toJSON() : { code: 'CLI_ERROR', message: error instanceof Error ? error.message : String(error) } })}\n`); process.exitCode = 1; });
