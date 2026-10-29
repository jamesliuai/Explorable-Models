import { createVisualizationSession } from '@explorable-models/core/declarative';
import { createVisualizationTools, createBrowserToolEndpoint } from '@explorable-models/agent';
import { mountVisualization } from '@explorable-models/player';
import type { RelayCall, RelayCancel } from '@explorable-models/agent';

// This is a local demonstration authentication credential, held only on the main thread.
// Production applications replace it with their established session/authentication transport.
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const output = document.querySelector<HTMLPreElement>('#result')!;
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const session = await createVisualizationSession();
const tools = createVisualizationTools({ session });
const surface = mountVisualization(document.querySelector<HTMLElement>('#surface')!, { session });
async function api(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); return data;
}
const endpoint = createBrowserToolEndpoint({ sessionId: session.id, tools, send: async message => { await api('/api/response', message); } });
let closed = false;
await api('/api/connect', { sessionId: session.id });
status.textContent = `Browser connected. Session ${session.id}. No model provider is connected.`;
const button = document.querySelector<HTMLButtonElement>('#run')!;
button.disabled = false;
button.onclick = async () => {
  button.disabled = true; status.textContent = 'Running the scripted server → browser workflow…';
  try { const result = await api('/api/scripted', { sessionId: session.id }); output.textContent = JSON.stringify(result, null, 2); status.textContent = 'Scripted create, revise, parameter commit, save and reopen completed.'; }
  catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; }
};
async function poll() {
  while (!closed) {
    try { const messages = await api(`/api/events?sessionId=${encodeURIComponent(session.id)}`) as (RelayCall | RelayCancel)[]; for (const message of messages) void endpoint.receive(message).catch(error => { status.textContent = String(error); }); }
    catch (error) { if (!closed) status.textContent = `Disconnected: ${String(error)}`; closed = true; endpoint.dispose(); }
  }
}
void poll();
window.addEventListener('pagehide', () => { closed = true; endpoint.dispose(); surface.dispose(); session.dispose(); void fetch('/api/disconnect', { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id }), keepalive: true }); }, { once: true });
