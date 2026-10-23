import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserSession } from './browser.js';
import { compileProject, type CompiledProject } from './compiler.js';
import { connect } from './coordinator.js';
import { CliError, exists, inside, readJSON } from './files.js';
import type { AgentService } from './mcp.js';
import type { CheckReport, ExperimentDefinition, Snapshot } from '../../core/src/types.js';

export interface ManagedService extends AgentService { close(): Promise<void>; readonly project: CompiledProject | undefined }
function failure(error: unknown): unknown { return { error: error instanceof CliError ? error.toJSON() : { code: 'MODEL_ERROR', message: error instanceof Error ? error.message : String(error) } }; }

/** Read an already built revision. Live inspection must not depend on editable source compiling. */
async function retainedProject(root: string, revision: string): Promise<CompiledProject> {
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) throw new CliError('INCOMPATIBLE_SNAPSHOT', 'The snapshot has an invalid definition revision.');
  for (const directory of [path.join(root, 'candidates', revision.slice(7)), root]) {
    if (!await exists(path.join(directory, 'definition.json'))) continue;
    const resolved = await inside(root, directory);
    const definition = await readJSON(path.join(resolved, 'definition.json')) as ExperimentDefinition;
    if (definition.definitionRevision !== revision) continue;
    // BrowserSession only consumes the immutable bundle and definition. These are borrowed,
    // so closing a service must never dispose another process's preview directory.
    return { directory: resolved, sourceDirectory: resolved, source: {}, dependencyLock: '', definition, dispose: async () => {} };
  }
  throw new CliError('INCOMPATIBLE_SNAPSHOT', 'The preview no longer retains the bundle matching this snapshot.', 'Reopen the exported bundle for this exact revision.');
}

/** Keep the initial entry point before activation changes the reload pointer. */
async function retainInitialProject(root: string): Promise<void> {
  const definition = await readJSON(path.join(root, 'definition.json')) as ExperimentDefinition;
  if (!/^sha256:[a-f0-9]{64}$/.test(definition.definitionRevision)) throw new CliError('INVALID_SOURCE', 'The preview artifact has an invalid revision.');
  const parent = path.join(root, 'candidates');
  const destination = path.join(parent, definition.definitionRevision.slice(7));
  if (await exists(path.join(destination, 'definition.json'))) return;
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.retain-'));
  try {
    for (const name of await readdir(root)) {
      if (name === 'candidates' || name === 'local-bridge.js' || name.endsWith('.pending')) continue;
      await cp(path.join(root, name), path.join(staging, name), { recursive: true });
    }
    // The retained copy is for frozen isolated playback, not a second live coordinator.
    const index = await readFile(path.join(staging, 'index.html'), 'utf8');
    await writeFile(path.join(staging, 'index.html'), index.replace(/<script\b[^>]*src=["']\.?\/?local-bridge\.js["'][^>]*><\/script>/g, ''));
    await rename(staging, destination);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function openService(directory: string, sessionFile?: string): Promise<ManagedService> {
  const remote = sessionFile ? await connect(sessionFile) : undefined;
  let project: CompiledProject | undefined;
  const projects: CompiledProject[] = [];
  let local: BrowserSession | undefined;
  try {
    if (!remote) {
      project = await compileProject(directory, { player: true });
      projects.push(project);
      local = await BrowserSession.create(project);
    }
  } catch (error) { await project?.dispose(); throw error; }
  const request = async (method: string, args: Record<string, unknown> = {}, sessionId?: string) => remote ? remote.request(method, args, sessionId) : local!.request(method, args);
  return {
    get project() { return project; },
    request,
    ...(remote ? { sessions: () => remote.sessions() } : {}),
    async capture(args) {
      try {
        const snapshot = args.snapshot ?? await request('checkpoint', {}, args.sessionId) as Snapshot;
        if ('error' in snapshot) return snapshot;
        const artifactRoot = remote?.connection.artifactDirectory ?? local?.project.directory;
        const captureProject = artifactRoot ? await retainedProject(artifactRoot, snapshot.definitionRevision) : projects.find(value => value.definition.definitionRevision === snapshot.definitionRevision);
        if (!captureProject) throw new CliError('INCOMPATIBLE_SNAPSHOT', 'No retained bundle matches the snapshot revision.');
        await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
        const capture = await BrowserSession.create(captureProject);
        try { return await capture.capture(path.resolve(args.output), { snapshot, width: args.width, height: args.height }); }
        finally { await capture.close(); }
      } catch (error) { return failure(error); }
    },
    async activate(args) {
      let candidate: CompiledProject | undefined;
      try {
        candidate = await compileProject(path.resolve(String(args.directory)), { player: true });
        const validation = await BrowserSession.create(candidate);
        let report: CheckReport;
        try { report = await validation.checked('verify') as CheckReport; }
        finally { await validation.close(); }
        if (!report.passed) throw new CliError('CHECK_FAILED', 'Candidate quantitative checks failed. The current experiment remains active.');
        const target = remote?.connection.artifactDirectory ?? local!.project.directory;
        if (!target) throw new CliError('UNSUPPORTED_CAPABILITY', 'This preview connection does not support source activation.');
        await retainInitialProject(target);
        const slug = candidate.definition.definitionRevision.slice(7);
        const relative = `candidates/${slug}/model-worker.js`;
        const destination = path.join(target, relative);
        const revisionDirectory=path.dirname(destination);
        await mkdir(revisionDirectory, { recursive: true });
        await cp(candidate.directory,revisionDirectory,{recursive:true});
        let index=await readFile(path.join(candidate.directory,'index.html'),'utf8');
        if(remote)index=index.replace('</body>','<script type="module" src="/local-bridge.js"></script></body>');
        await writeFile(path.join(revisionDirectory,'index.html'),index);
        index=index.replace('<head>',`<head><base href="/candidates/${slug}/">`);
        const pendingIndex=path.join(target,`index-${slug}.pending`);await writeFile(pendingIndex,index);
        const result = await request('activate_revision', { definition: candidate.definition, workerUrl: `/${relative}`, report, expectedDefinitionRevision: args.expectedDefinitionRevision, expectedRunVersion: args.expectedRunVersion, expectedActiveRunId: args.expectedActiveRunId }, args.sessionId as string | undefined);
        if (result && typeof result === 'object' && 'error' in result) { await rm(pendingIndex,{force:true}); await candidate.dispose(); return result; }
        // All build and asset writes finish before guarded activation. Only this atomic pointer swap follows.
        let reloadWarning:string|undefined;
        try{await rename(pendingIndex,path.join(target,'index.html'));}catch(error){reloadWarning=`Revision activated in the current player, but the reload pointer could not be updated: ${error instanceof Error?error.message:String(error)}`;}
        project = candidate; projects.push(candidate); candidate = undefined;
        return { activation: result, report, ...(reloadWarning?{warning:reloadWarning}:{}) };
      } catch (error) { await candidate?.dispose(); return failure(error); }
    },
    async close() { await local?.close(); await Promise.all(projects.map(value => value.dispose())); },
  };
}
