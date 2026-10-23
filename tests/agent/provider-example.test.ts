import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const descriptors = [{name:'visualization_inspect',description:'Inspect',inputSchema:{type:'object',properties:{}}}];
const adapter = () => import(pathToFileURL(path.resolve('examples/host-relay/openai-agent.mjs')).href);
describe('optional server provider example (mock transport, no API calls)',()=>{
  it('pins authorization to the host session and returns tool results with call correlation',async()=>{
    const {runOpenAIAgent}=await adapter();const requests:Record<string,unknown>[]=[];const dispatches:Record<string,unknown>[]=[];
    const fetchImpl=async (_url:string,init:RequestInit)=>{const request=JSON.parse(String(init.body));requests.push(request);return new Response(JSON.stringify(requests.length===1?{id:'response-1',output:[{type:'function_call',name:'visualization_inspect',call_id:'call-1',arguments:'{}'}],usage:{total_tokens:10}}:{id:'response-2',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Inspected.'}]}]}));};
    const result=await runOpenAIAgent({descriptors,prompt:'Inspect this document',model:'host-selected-model',apiKey:'mock-secret',principal:'authenticated-user',sessionId:'allowed-session',relay:{dispatch:async(value:Record<string,unknown>)=>{dispatches.push(value);return {ok:true,data:{status:'ready'}};}},fetchImpl});
    expect(result.text).toBe('Inspected.');expect(dispatches[0]).toMatchObject({principal:'authenticated-user',sessionId:'allowed-session',name:'visualization_inspect'});expect(requests[1]).toMatchObject({previous_response_id:'response-1',input:[{type:'function_call_output',call_id:'call-1',output:JSON.stringify({ok:true,data:{status:'ready'}})}]});expect(JSON.stringify(requests)).not.toContain('mock-secret');
  });
  it('refuses invented tools without dispatching them',async()=>{
    const {runOpenAIAgent}=await adapter();let dispatched=false;await expect(runOpenAIAgent({descriptors,prompt:'x',model:'host-model',apiKey:'mock',principal:'user',sessionId:'session',relay:{dispatch:()=>{dispatched=true;}},fetchImpl:async()=>new Response(JSON.stringify({id:'r',output:[{type:'function_call',name:'install_package',call_id:'c',arguments:'{}'}]}))})).rejects.toThrow('Unexpected');expect(dispatched).toBe(false);
  });
});
