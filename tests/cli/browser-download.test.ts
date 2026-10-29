import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { compileProject } from '../../packages/cli/src/compiler';
import { exportArtifact } from '../../packages/cli/src/artifacts';
import { BrowserSession } from '../../packages/cli/src/browser';
import { serveStatic } from '../../packages/cli/src/server';
import type { CheckReport } from '../../packages/core/src/types';

describe('browser-download portable state',()=>{
 it('downloads a revision-matched bundle that reopens the selected state with valid asset hashes',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'experiment-download-'));
  const project=await compileProject(path.resolve('examples/linear-map'),{player:true});
  const verifier=await BrowserSession.create(project);
  const report=await verifier.request('verify') as CheckReport;
  await verifier.close();
  const out=path.join(temp,'export');await exportArtifact(project,out,report);
  const server=await serveStatic(out);const browser=await chromium.launch();let reopened:Awaited<ReturnType<typeof serveStatic>>|undefined;
  try{
   const context=await browser.newContext();const browserErrors:string[]=[];
   context.on('page',page=>{page.on('pageerror',error=>browserErrors.push(error.stack??error.message));page.on('console',message=>{if(message.type()==='error')browserErrors.push(`${page.url()}: ${message.text()}`);});});
   const page=await context.newPage();await page.goto(server.url);await page.waitForFunction(()=>!!window.__EXPLORABLE_MODELS__);
   await page.evaluate(async()=>{const api=window.__EXPLORABLE_MODELS__!;const s=await api.request({method:'state'}) as any;await api.request({method:'command',args:{type:'set_parameters',parameters:{a:2,b:.5,x:-1,y:2},expectedRunVersion:s.run.version,expectedActiveRunId:s.activeRunId}});});
   await page.getByRole('button',{name:'Export',exact:true}).click();
   const pending=page.waitForEvent('download');await page.getByRole('button',{name:/Download runnable bundle/}).click();const download=await pending;const file=await download.path();expect(file).not.toBeNull();
   const archive=unzipSync(await readFile(file!));const manifest=JSON.parse(new TextDecoder().decode(archive['bundle-manifest.json']));
   for(const asset of manifest.assets){expect(archive[asset.path]).toBeDefined();expect(`sha256:${createHash('sha256').update(archive[asset.path]).digest('hex')}`).toBe(asset.sha256);}
   const dir=path.join(temp,'reopened');await mkdir(dir);
   for(const [name,data] of Object.entries(archive)){expect(name).not.toContain('..');await mkdir(path.dirname(path.join(dir,name)),{recursive:true});await writeFile(path.join(dir,name),data);}
   reopened=await serveStatic(dir);const fresh=await context.newPage();const origin=reopened.url;
   await fresh.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
   await fresh.goto(origin);
   // waitForFunction treats a Promise as truthy before its boolean result resolves.
   // Poll the awaited inspection in Node so startup and restoration must both finish.
   await expect.poll(()=>fresh.evaluate(async()=>window.__EXPLORABLE_MODELS__?await window.__EXPLORABLE_MODELS__.request({method:'inspect'}):null)).toMatchObject({parameters:{a:2,x:-1}});
   const result=await fresh.evaluate(()=>window.__EXPLORABLE_MODELS__!.request({method:'inspect'})).catch(error=>{throw new Error(`${error.message}\nBrowser diagnostics:\n${browserErrors.join('\n')}`);}) as any;
   expect(result.quantities['point.output'].value,JSON.stringify({result,browserErrors})).toEqual([-1,2]);expect(result.definitionRevision).toBe(project.definition.definitionRevision);
   expect(browserErrors).toEqual([]);
  }finally{await browser.close();await reopened?.close();await server.close();await project.dispose();await rm(temp,{recursive:true,force:true});}
 },30000);
});
