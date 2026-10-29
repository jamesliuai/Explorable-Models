/**
 * EXAMPLE model worker for the observed-data page: core's real worker protocol (`serveModelWorker`) with schema 2.0
 * document execution enabled and no kernels, because the example model is a bounded document. Requests carry the
 * manifest and data only, never code; observed rows are attached from the manifest and checked again on the page.
 */
import { enableDocumentExecution, serveModelWorker, type WorkerScope } from '@experiment-kit/core/model';

enableDocumentExecution();
serveModelWorker(self as unknown as WorkerScope, []);
