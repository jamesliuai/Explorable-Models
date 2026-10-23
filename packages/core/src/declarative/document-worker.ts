import { compileDocument } from './validation.js';
import { evaluateCompiledDocument } from './evaluation.js';
import { DocumentError, type EvaluationRequest } from './types.js';
const scope = globalThis as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    postMessage(message: unknown): void;
};
scope.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as {
        type?: string;
        id?: string;
        request?: EvaluationRequest;
    };
    if (message?.type !== 'evaluate' || typeof message.id !== 'string' || !message.request)
        return;
    try {
        const request = message.request;
        const compiled = compileDocument(request.document);
        const frame = evaluateCompiledDocument(compiled, request.params, request.time);
        scope.postMessage({ type: 'result', id: message.id, frame });
    }
    catch (error) {
        scope.postMessage({ type: 'error', id: message.id, diagnostics: error instanceof DocumentError ? error.diagnostics : [{ code: 'WORKER_ERROR', path: '$', message: error instanceof Error ? error.message : 'Document evaluation failed.' }] });
    }
});
