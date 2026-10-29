/**
 * Catalogue kernel worker entry. Serves `{ type: 'evaluate' }` requests with the installed pure kernels only; requests
 * carry installed IDs and data, never source. Each kernel's code is loaded in this worker on first use
 * (`INSTALLED_KERNEL_SOURCE`), so the worker starts without any kernel code and fetches only the kernels its activity
 * needs. It imports no templates, copy or manifests, and does not enable schema 2.0 document execution: the installed
 * catalogue serves kernel models only (a host serving document-kind models supplies its own worker, see
 * `enableDocumentExecution` in @experiment-kit/core/model).
 */
import { serveModelWorker, type WorkerScope } from '@experiment-kit/core/model';
import { INSTALLED_KERNEL_SOURCE } from './kernels/loaders.js';

serveModelWorker(self as unknown as WorkerScope, INSTALLED_KERNEL_SOURCE);
