import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('declarative stdio MCP authoring (scripted protocol integration)', () => {
  it('creates, revises, operates, saves and reopens in a blank browser worker session without a source project', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'explorable-models-mcp-empty-'));
    const client = new Client({ name: 'explorable-models-document-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('packages/cli/bin/explorable-models.mjs'), 'mcp-document'], cwd: directory, stderr: 'pipe' });
    let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    let operation = 0;
    try {
      await client.connect(transport);
      const tools = await client.listTools(); expect(tools.tools).toHaveLength(9); expect(tools.tools.every(tool => tool.inputSchema && tool.outputSchema)).toBe(true);
      const call = async (name: string, input: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: input });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        let payload = result.structuredContent as { ok: boolean; data: any };
        if (payload.data?.resource) { const resource = await client.readResource({ uri: payload.data.resource.uri }); payload = JSON.parse((resource.contents[0] as { text: string }).text); }
        expect(payload.ok).toBe(true); return payload.data;
      };
      const guard = async () => ({ ...(await call('visualization_inspect')).guard, operationId: `mcp-document-${++operation}` });
      const discovered = await call('visualization_discover', { includeExample: true }); expect(discovered.documentSchema.properties.schemaVersion.const).toBe('2.0');
      const created = await call('visualization_create', { document: discovered.example, guard: await guard() });
      await call('visualization_commit', { candidateId: created.candidateId, guard: await guard() });
      const initial = await call('visualization_inspect');
      const revised = await call('visualization_revise', { guard: await guard(), edits: [{ op: 'metadata', title: 'Created over stdio' }] });
      const committed = await call('visualization_commit', { candidateId: revised.candidateId, guard: await guard() }); expect(committed.run.id).toBe(initial.run.id);
      await call('visualization_operate', { action: 'parameters', parameters: { amplitude: 2 }, guard: await guard() });
      const artifact = await call('visualization_save'); expect(artifact.document.title).toBe('Created over stdio'); expect(artifact.run.params.amplitude).toBe(2);
      const restored = await call('visualization_restore', { artifact, guard: await guard() }); expect(restored.run.restoredFrom).toBe(artifact.run.id); expect(restored.identity).toEqual(artifact.identity);
      const rejected = await client.callTool({ name: 'visualization_create', arguments: { document: { ...discovered.example, quantities: { hacked: { expression: 'globalThis.process' } } }, guard: await guard() } }); expect(rejected.isError).toBe(true);
      expect((await call('visualization_inspect')).run.id).toBe(restored.run.id);
    } catch (error) { if (diagnostics) console.error(diagnostics); throw error; }
    finally { await client.close(); await transport.close(); await rm(directory, { recursive: true, force: true }); }
  }, 40000);
});
