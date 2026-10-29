import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { VisualizationToolResult, ToolDescriptor } from '../../agent/src/tools.js';
import { DOCUMENT_RUNTIME_VERSION } from '../../core/src/declarative-session.js';

export interface DocumentToolExecutor { readonly descriptors: readonly ToolDescriptor[]; execute(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<VisualizationToolResult> }
/** Direct JSON-schema adapter over exactly the same provider-neutral authoring service. */
export function createDocumentMcpServer(executor: DocumentToolExecutor): Server {
  const server = new Server({ name: 'explorable-models-document', version: DOCUMENT_RUNTIME_VERSION }, { capabilities: { tools: {}, resources: {} } });
  const resources = new Map<string, string>();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: executor.descriptors.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, type: 'object' as const }, outputSchema: { ...tool.outputSchema, type: 'object' as const }, annotations: { readOnlyHint: ['visualization_discover', 'visualization_inspect', 'visualization_save'].includes(tool.name), destructiveHint: false, openWorldHint: false } })) }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [...resources.keys()].map(uri => ({ uri, name: 'Retained declarative tool result', mimeType: 'application/json' })) }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => { const text = resources.get(params.uri); if (text === undefined) throw new McpError(ErrorCode.InvalidParams, 'Result resource is missing or evicted.'); return { contents: [{ uri: params.uri, mimeType: 'application/json', text }] }; });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await executor.execute(request.params.name, request.params.arguments ?? {}, { signal: extra.signal });
    const text = JSON.stringify(result); const bytes = Buffer.byteLength(text);
    if (bytes <= 96 * 1024) return { content: [{ type: 'text' as const, text }], structuredContent: result, isError: !result.ok };
    if (bytes > 4_100_000) { const error = { ok: false, diagnostics: [{ code: 'RESOURCE_LIMIT', path: '$', message: 'MCP result exceeds the bounded resource size.', recovery: 'Request fewer quantities or a smaller document.' }] }; return { content: [{ type: 'text' as const, text: JSON.stringify(error) }], structuredContent: error, isError: true }; }
    while (resources.size >= 16 || [...resources.values()].reduce((size, value) => size + Buffer.byteLength(value), 0) + bytes > 16_000_000) resources.delete(resources.keys().next().value!);
    const uri = `explorable-models://document-results/${randomUUID()}`; resources.set(uri, text);
    const summary = { ok: true, data: { resource: { uri, mimeType: 'application/json', bytes }, note: 'Read this session-owned resource for the exact tool result. Save artifacts to host storage for durable persistence.' } };
    return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }, { type: 'resource_link' as const, uri, name: 'Declarative tool result', mimeType: 'application/json' }], structuredContent: summary, isError: !result.ok };
  });
  return server;
}
export async function serveDocumentMcp(executor: DocumentToolExecutor): Promise<Server> { const server = createDocumentMcpServer(executor); await server.connect(new StdioServerTransport()); return server; }
