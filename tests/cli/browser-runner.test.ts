import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileProject } from '../../packages/cli/src/compiler';
import { BrowserSession } from '../../packages/cli/src/browser';
import { main } from '../../packages/cli/src/index';
import type { CheckReport, Inspection, RuntimeState, Snapshot } from '../../packages/core/src/types';

const directories: string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
describe('actual browser worker runner',()=>{
  it('uses the compiled model for inspection, isolated samples, author checks, and portable state',async()=>{
    const project=await compileProject(path.resolve('examples/linear-map'));
    const browser=await BrowserSession.create(project);
    try {
      const original=await browser.checked('inspect') as Inspection;
      expect(original.quantities['point.output']!.value).toEqual([2,1]);
      await browser.checked('sample',{parameters:{a:2,b:0,c:0,d:3},times:[0]});
      expect((await browser.checked('inspect') as Inspection).frameId).toBe(original.frameId);
      const changed=await browser.checked('command',{type:'set_parameters',parameters:{a:2,b:0,c:0,d:3,x:1.25,y:-0.75},expectedRunVersion:original.runVersion,expectedActiveRunId:original.runId}) as {state:RuntimeState};
      expect(changed.state.frame.quantities['point.output']!.value).toEqual([2.5,-2.25]);
      const stale=await browser.request('command',{type:'reset',expectedRunVersion:original.runVersion,expectedActiveRunId:original.runId});
      expect(stale).toMatchObject({error:{code:'CONFLICT'}});
      const snapshot=await browser.checked('checkpoint') as Snapshot;
      const fresh=await BrowserSession.create(project);
      try {
        const state=await fresh.checked('state') as RuntimeState;
        await fresh.checked('command',{type:'restore',snapshot,expectedRunVersion:state.run.version,expectedActiveRunId:state.activeRunId});
        const restored=await fresh.checked('inspect') as Inspection;
        expect(restored.quantities['point.output']!.value).toEqual([2.5,-2.25]); expect(restored.runId).not.toBe(snapshot.runId);
      }finally{await fresh.close();}
      const report=await browser.checked('verify') as CheckReport; expect(report.passed).toBe(true); expect(report.provenance).toBe('author'); expect(report.learnerEvidence).toBe('not_evaluated');
    }finally{await browser.close();await project.dispose();}
  },20000);
  it('terminates a nonresponding candidate worker without running candidate code in Node',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'experiment-infinite-'));directories.push(dir);await main(['init',dir]);
    const model=path.join(dir,'model.ts');await writeFile(model,`while(true) {}\n${await readFile(model,'utf8')}`);
    const project=await compileProject(dir);
    try{await expect(BrowserSession.create(project)).rejects.toThrow(/TIMEOUT|timed out|respond|watchdog/i);}finally{await project.dispose();}
  },15000);
});
