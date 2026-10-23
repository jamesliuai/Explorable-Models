import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../packages/cli/src/mcp';
import { BrowserSession } from '../../packages/cli/src/browser';
import { compileProject } from '../../packages/cli/src/compiler';
import type { Inspection } from '../../packages/core/src/types';
import path from 'node:path';

describe('MCP protocol contract',()=>{
  it('negotiates the official protocol, publishes typed tools, and operates the real browser runtime',async()=>{
    const project=await compileProject(path.resolve('examples/base-rates'));const browser=await BrowserSession.create(project);
    const server=createMcpServer({request:(method,args)=>browser.request(method,args),capture:async()=>({error:{code:'UNSUPPORTED_CAPABILITY',message:'Capture is tested through CLI integration.'}}),activate:async()=>({error:{code:'UNSUPPORTED_CAPABILITY',message:'Activation is tested through runtime integration.'}})});
    const client=new Client({name:'experiment-kit-protocol-test',version:'1.0.0'});const [a,b]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(a);await client.connect(b);
      const list=await client.listTools();expect(list.tools.map(t=>t.name)).toEqual(['describe','inspect','create_run','command','sample','compare','checkpoint','capture','verify','activate_revision']);expect(list.tools.every(t=>t.inputSchema&&t.outputSchema)).toBe(true);
      const initial=await client.callTool({name:'inspect',arguments:{}});const frame=(initial.structuredContent as {result:Inspection}).result;expect(frame.quantities['probability.posterior']?.value??frame.quantities['probability.defectGivenFlagged']?.value).toBeCloseTo(90/585,10);
      const stale=await client.callTool({name:'command',arguments:{type:'reset',expectedRunVersion:99,expectedActiveRunId:frame.runId}});expect(stale.isError).toBe(true);expect(stale.structuredContent).toMatchObject({result:{error:{code:'CONFLICT'}}});
      const changed=await client.callTool({name:'create_run',arguments:{parameters:{prevalence:0.1},expectedRunVersion:frame.runVersion,expectedActiveRunId:frame.runId}});expect(changed.isError).not.toBe(true);
      const report=await client.callTool({name:'verify',arguments:{}});expect(report.structuredContent).toMatchObject({result:{passed:true,provenance:'author'}});
      const invalid=await client.callTool({name:'sample',arguments:{times:[-1]}});expect(invalid.isError).toBe(true);
      const sampled=await client.callTool({name:'sample',arguments:{times:Array.from({length:180},()=>0)}});const resource=(sampled.structuredContent as {result:{resource:{uri:string};frameCount:number}}).result;expect(resource.frameCount).toBe(180);const data=await client.readResource({uri:resource.resource.uri});expect(JSON.parse((data.contents[0] as {text:string}).text).frames).toHaveLength(180);
    }finally{await client.close();await server.close();await browser.close();await project.dispose();}
  },20000);
});
