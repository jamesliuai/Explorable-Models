import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, readJSON, writeJSON } from './files.js';
import { serveStatic, type StaticServer } from './server.js';

interface PendingCommand { id: string; method: string; args: Record<string, unknown> }
interface Session { id: string; title: string; lastSeen: number; queue: PendingCommand[]; waiter?: (command: PendingCommand | null) => void }
export interface ConnectionFile { schemaVersion: '1.0'; url: string; token: string; sessionId?: string; artifactDirectory?: string }
export interface Coordinator { server: StaticServer; connection: ConnectionFile; close(): Promise<void> }
export async function createCoordinator(directory: string, port?: number): Promise<Coordinator> {
  const sessions = new Map<string, Session>();
  const responses = new Map<string, { sessionId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const server = await serveStatic(directory, { port, api: async raw => {
    if (!raw || typeof raw !== 'object') throw new CliError('INVALID_COMMAND', 'Expected a coordinator request object.');
    const input = raw as Record<string, unknown>;
    const id = typeof input.sessionId === 'string' ? input.sessionId : undefined;
    const active = [...sessions.values()].filter(s => Date.now() - s.lastSeen < 65000);
    switch (input.operation) {
      case 'sessions': return { sessions: active.map(({ id, title }) => ({ id, title })) };
      case 'register': {
        if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new CliError('INVALID_COMMAND', 'Invalid browser session ID.');
        sessions.set(id, { id, title: typeof input.title === 'string' ? input.title.slice(0, 120) : 'Experiment player', lastSeen: Date.now(), queue: [] });
        return { sessionId: id };
      }
      case 'unregister': {
        const session=id?sessions.get(id):undefined;
        if(session){session.waiter?.(null);sessions.delete(session.id);for(const [requestId,pending]of responses)if(pending.sessionId===session.id){clearTimeout(pending.timer);responses.delete(requestId);pending.reject(new CliError('SESSION_CLOSED','The selected browser page closed or reloaded.'));}}
        return {closed:true};
      }
      case 'poll': {
        const session = id ? sessions.get(id) : undefined;
        if (!session) throw new CliError('NOT_FOUND', 'Browser session is not registered.');
        session.lastSeen = Date.now();
        const queued = session.queue.shift(); if (queued) return queued;
        if (session.waiter) throw new CliError('BUSY', 'This session already has a waiting poll.');
        return new Promise<PendingCommand | null>(resolve => { const timer = setTimeout(() => { session.waiter = undefined; resolve(null); }, 20000); session.waiter = command => { clearTimeout(timer); session.waiter = undefined; resolve(command); }; });
      }
      case 'respond': {
        const pending = typeof input.requestId === 'string' ? responses.get(input.requestId) : undefined;
        if (!pending || pending.sessionId !== id) throw new CliError('NOT_FOUND', 'Unknown response or wrong browser session.');
        clearTimeout(pending.timer); responses.delete(input.requestId as string); pending.resolve(input.result); return { accepted: true };
      }
      case 'request': {
        const session = id ? active.find(s => s.id === id) : active.length === 1 ? active[0] : undefined;
        if (!session) throw new CliError(active.length > 1 ? 'SESSION_REQUIRED' : 'NOT_FOUND', active.length > 1 ? 'Several players are open. Provide sessionId from the sessions operation.' : 'No active player session. Open the preview URL first.');
        if (typeof input.method !== 'string' || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new CliError('INVALID_COMMAND', 'A method and arguments object are required.');
        if (responses.size >= 32) throw new CliError('RESOURCE_LIMIT', 'Too many pending preview requests.');
        const command = { id: randomUUID(), method: input.method, args: input.args as Record<string, unknown> };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { responses.delete(command.id); session.queue = session.queue.filter(item => item.id !== command.id); reject(new CliError('TIMEOUT', 'The selected player did not answer within 15 seconds.')); }, 15000);
          responses.set(command.id, { sessionId: session.id, resolve, reject, timer });
          if (session.waiter) session.waiter(command); else session.queue.push(command);
        });
      }
      default: throw new CliError('INVALID_COMMAND', 'Unknown coordinator operation.');
    }
  } });
  const connection: ConnectionFile = { schemaVersion: '1.0', url: server.url, token: server.token, artifactDirectory: directory };
  const bridge = `const token=${JSON.stringify(server.token)};\nconst trustedOrigin=${JSON.stringify(server.url)};\nconst sessionId=crypto.randomUUID();\nconst endpoint=trustedOrigin+'/__experiment/api';\nconst send=async data=>{if(location.origin!==trustedOrigin)throw new Error('Invalid bridge origin');const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({...data,sessionId}),keepalive:data.operation==='unregister'});if(!response.ok)throw new Error('Local experiment bridge rejected request');return response.json();};\nasync function start(){if(location.origin!==trustedOrigin)return;await send({operation:'register',title:document.title});while(true){try{const command=await send({operation:'poll'});if(!command)continue;let result;try{const api=window.__EXPERIMENT_KIT__;result=api?await api.request({method:command.method,args:command.args}):{error:{code:'BUSY',message:'Player is starting.'}};}catch(error){result={error:{code:error.code||'MODEL_ERROR',message:error.message}};}await send({operation:'respond',requestId:command.id,result});}catch(error){await new Promise(resolve=>setTimeout(resolve,2000));}}}window.addEventListener('pagehide',()=>{void send({operation:'unregister'}).catch(()=>{});});start();\n`;
  await writeFile(path.join(directory, 'local-bridge.js'), bridge);
  const indexPath = path.join(directory, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, html.replace('</body>', '<script type="module" src="./local-bridge.js"></script></body>'));
  return { server, connection, close: async () => { for (const session of sessions.values()) session.waiter?.(null); for (const response of responses.values()) { clearTimeout(response.timer); response.reject(new CliError('SESSION_CLOSED', 'Preview server closed.')); } await server.close(); } };
}
export async function saveConnection(file: string, connection: ConnectionFile): Promise<void> {
  await writeJSON(file, connection);
  const { chmod } = await import('node:fs/promises'); await chmod(file, 0o600);
}
export async function connect(file: string): Promise<{ connection: ConnectionFile; request(method: string, args?: Record<string, unknown>, sessionId?: string): Promise<unknown>; sessions(): Promise<unknown> }> {
  const value = await readJSON(file) as ConnectionFile;
  const url = new URL(value.url);
  if (value.schemaVersion !== '1.0' || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/' || !/^[a-f0-9]{64}$/.test(value.token)) throw new CliError('INVALID_SESSION', 'The connection file is not a valid local session.');
  const send = async (input: Record<string, unknown>) => {
    const response = await fetch(`${url.origin}/__experiment/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value.token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
    const result: unknown = await response.json();
    return result;
  };
  return { connection: value, request: (method, args = {}, sessionId) => send({ operation: 'request', method, args, sessionId: sessionId ?? value.sessionId }), sessions: () => send({ operation: 'sessions' }) };
}
