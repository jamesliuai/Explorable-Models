import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unzipSync } from 'fflate';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileProject } from '../../packages/cli/src/compiler';
import { BrowserSession } from '../../packages/cli/src/browser';
import { createCoordinator, connect, saveConnection } from '../../packages/cli/src/coordinator';
import { openService } from '../../packages/cli/src/service';
import { main } from '../../packages/cli/src/index';
import { exportArtifact } from '../../packages/cli/src/artifacts';
import { serveStatic } from '../../packages/cli/src/server';
import type { CheckReport, Inspection, Snapshot } from '../../packages/core/src/types';

describe('complete author and agent workflow',()=>{
  it('exports a usable offline player with source, matching identity, working controls, and frozen capture',async()=>{
    const temp=await mkdtemp(path.join(tmpdir(),'experiment-export-test-'));
    const project=await compileProject(path.resolve('examples/linear-map'),{player:true});const runner=await BrowserSession.create(project);
    try{
      const report=await runner.checked('verify') as CheckReport;
      const output=path.join(temp,'export');await exportArtifact(project,output,report,true);
      const snapshot=await runner.checked('checkpoint') as Snapshot;
      const capture=await runner.capture(path.join(temp,'frame.png'),{snapshot});expect(capture).toMatchObject({identity:{definitionRevision:project.definition.definitionRevision},externalNetwork:'blocked'});
      expect((await readFile(path.join(temp,'frame.png'))).byteLength).toBeGreaterThan(10000);
      const server=await serveStatic(output);const browser=await chromium.launch();const context=await browser.newContext();
      const external:string[]=[];await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==server.url){external.push(route.request().url());return route.abort();}return route.continue();});
      const page=await context.newPage();
      try{
        await page.goto(server.url);await page.waitForFunction(()=>Boolean(window.__EXPLORABLE_MODELS__));
        const inspection=await page.evaluate(()=>window.__EXPLORABLE_MODELS__!.request({method:'inspect'})) as Inspection;
        expect(inspection.definitionRevision).toBe(project.definition.definitionRevision);
        await page.getByRole('button',{name:'Reflection',exact:true}).click();
        await expect.poll(async()=>{const value=await page.evaluate(()=>window.__EXPLORABLE_MODELS__!.request({method:'inspect'})) as Inspection;return value.quantities['matrix.determinant']!.value;}).toBe(-1);
        const source=await page.request.get(`${server.url}/source/linear-map/model.ts`);expect(source.ok()).toBe(true);
        await page.getByRole('button',{name:'Export',exact:true}).click();
        const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:/^Download source/}).click();const download=await downloadPromise;const sourceZip=path.join(temp,'downloaded-source.zip');await download.saveAs(sourceZip);const downloaded=unzipSync(await readFile(sourceZip));expect(Object.keys(downloaded)).toEqual(expect.arrayContaining(['model.ts','experiment.json','package-lock.json','snapshot.json']));
        expect(external).toEqual([]);
      }finally{await context.close();await browser.close();await server.close();}
    }finally{await runner.close();await project.dispose();await rm(temp,{recursive:true,force:true});}
  },30000);
  it('routes live commands, protects newer learner edits, and safely activates only checked source',async()=>{
    const temp=await mkdtemp(path.join(tmpdir(),'experiment-live-test-'));const source=path.join(temp,'lesson');await main(['init',source]);
    const project=await compileProject(source,{player:true});const coordinator=await createCoordinator(project.directory);const file=path.join(temp,'connection.json');await saveConnection(file,coordinator.connection);
    const browser=await chromium.launch();const page=await browser.newPage();let service:Awaited<ReturnType<typeof openService>>|undefined;
    try{
      await page.goto(coordinator.server.url);await page.waitForFunction(()=>Boolean(window.__EXPLORABLE_MODELS__));
      const connection=await connect(file);await expect.poll(async()=>((await connection.sessions()) as {sessions:unknown[]}).sessions.length).toBe(1);
      const original=await connection.request('inspect') as Inspection;
      const originalSnapshot=await connection.request('checkpoint') as Snapshot;const snapshotFile=path.join(temp,'original-snapshot.json');await writeFile(snapshotFile,JSON.stringify(originalSnapshot));
      await page.getByRole('button',{name:'Reflection',exact:true}).click();
      const stale=await connection.request('command',{type:'reset',expectedRunVersion:original.runVersion,expectedActiveRunId:original.runId});expect(stale).toMatchObject({error:{code:'CONFLICT'}});
      const current=await connection.request('inspect') as Inspection;expect(current.quantities['matrix.determinant']!.value).toBe(-1);
      await main(['capture',source,'--session',file,'--snapshot',snapshotFile,'--out',path.join(temp,'isolated.png')]);expect((await connection.request('inspect') as Inspection).frameId).toBe(current.frameId);
      service=await openService(source,file);
      const manifest=JSON.parse(await readFile(path.join(source,'experiment.json'),'utf8'));manifest.description='A checked source revision for the live workflow test.';await writeFile(path.join(source,'experiment.json'),JSON.stringify(manifest,null,2));
      const activated=await service.activate({directory:source,expectedDefinitionRevision:current.definitionRevision,expectedRunVersion:current.runVersion,expectedActiveRunId:current.runId});expect(activated).toHaveProperty('activation');
      const revised=await connection.request('inspect') as Inspection;expect(revised.definitionRevision).not.toBe(current.definitionRevision);expect(revised.parameters.a).toBe(1);
      await writeFile(path.join(source,'model.ts'),'this is invalid TypeScript;');
      const failed=await service.activate({directory:source,expectedDefinitionRevision:revised.definitionRevision,expectedRunVersion:revised.runVersion,expectedActiveRunId:revised.runId});expect(failed).toHaveProperty('error');expect((await connection.request('inspect') as Inspection).frameId).toBe(revised.frameId);
      // A newly connected agent can still inspect, operate, and capture the last good
      // revision while the author's editable source does not compile.
      const reconnected=await openService(source,file);
      try{
        expect(reconnected.project).toBeUndefined();
        expect(await reconnected.request('inspect')).toMatchObject({frameId:revised.frameId});
        expect(await reconnected.request('describe')).toHaveProperty('manifest');
        const reset=await reconnected.request('command',{type:'reset',expectedRunVersion:revised.runVersion,expectedActiveRunId:revised.runId});expect(reset).not.toHaveProperty('error');
        const afterReset=await reconnected.request('inspect') as Inspection;
        const currentCapture=await reconnected.capture({output:path.join(temp,'retained-current.png')});expect(currentCapture).toMatchObject({identity:{definitionRevision:revised.definitionRevision}});
        const oldCapture=await reconnected.capture({output:path.join(temp,'retained-original.png'),snapshot:originalSnapshot});expect(oldCapture).toMatchObject({identity:{definitionRevision:original.definitionRevision}});
        expect((await reconnected.request('inspect') as Inspection).frameId).toBe(afterReset.frameId);
      }finally{await reconnected.close();}
      await page.reload();await page.waitForFunction(()=>Boolean(window.__EXPLORABLE_MODELS__));expect((await page.evaluate(()=>window.__EXPLORABLE_MODELS__!.request({method:'inspect'})) as Inspection).definitionRevision).toBe(revised.definitionRevision);
    }finally{await service?.close();await browser.close();await coordinator.close();await project.dispose();await rm(temp,{recursive:true,force:true});}
  },45000);
  it('supports a fresh external stdio MCP client without mixing diagnostics into stdout',async()=>{
    const client=new Client({name:'external-stdio-validation',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('packages/cli/bin/explorable-models.mjs'),'mcp',path.resolve('examples/linear-map')],stderr:'pipe'});
    try{await client.connect(transport);const tools=await client.listTools();expect(tools.tools).toHaveLength(10);const inspected=await client.callTool({name:'inspect',arguments:{}});expect(inspected.structuredContent).toMatchObject({result:{experimentId:'linear-map'}});const verified=await client.callTool({name:'verify',arguments:{}});expect(verified.structuredContent).toMatchObject({result:{passed:true}});}finally{await client.close();}
  },30000);
});
