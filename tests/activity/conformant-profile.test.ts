/**
 * The core restore, authority, independence, exposure, host-authority and deletion suites, run again against the memory
 * host's `conformant` profile: every decision against a request is reported under the HostPort refusal convention
 * (activity-runtime §10), as the reference host does, instead of the `test-double` profile's other rejection codes, which
 * the adapter treats as retryable persistence failures. These suites must hold for a host that follows the convention
 * (fixture-host results).
 */
import { MemoryHost } from './support/memory-host.js';

MemoryHost.defaultProfile = 'conformant';
await import('./restore.test.js');
await import('./authority.test.js');
await import('./independence.test.js');
await import('./exposure.test.js');
await import('./host-authority.test.js');
await import('./deletion.test.js');
