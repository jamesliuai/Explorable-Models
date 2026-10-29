# @experiment-kit/agent

Provider-neutral document tools and Study Harness activity tools (`0.3.0-preview.1`, unreleased; see [below](#study-harness-activity-tools)). The host supplies its agent, authentication, persistence and transport. This package has no model-provider SDK, compiler or filesystem dependency.

```ts
import { createVisualizationSession } from '@experiment-kit/core/declarative';
import { createVisualizationTools } from '@experiment-kit/agent';

const session = await createVisualizationSession(); // browser worker by default
const tools = createVisualizationTools({ session });
// Register tools.descriptors with your agent host, adapting its tool-call envelope.
const discovered = await tools.execute('visualization_discover', { includeExample: true });
const inspected = await tools.execute('visualization_inspect', {});
// Every result is {ok:true,data} or {ok:false,diagnostics}.
```

`descriptors` contains JSON input/output schemas for discovery, create, revise, inspect, commit, discard, operate, save and restore. `execute(name, input, {signal})` accepts JSON-compatible input and an optional AbortSignal. Unknown fields, unsupported operations and invalid references produce bounded diagnostics with document paths and repair suggestions.

Creation and revision return a validated candidate ID. Commit that ID explicitly with the current guard. No files or compilation are needed. Revisions use stable quantity, series, view and mark IDs; an atomic batch can add a quantity and its bindings together. Candidate computation validation is an author check, not independent scientific review or visual review.

```ts
const guard = () => {
  const state = session.getState();
  return {
    sessionId: session.id,
    expectedVersion: state.version,
    ...(state.run && { expectedRunId: state.run.id }),
    operationId: crypto.randomUUID(),
    origin: 'agent',
  };
};
if (!discovered.ok) throw new Error(discovered.diagnostics[0].message);
const example = (discovered.data as { example: import('@experiment-kit/core/declarative').VisualizationDocument }).example;
const candidate = await tools.execute('visualization_create', {
  document: example,
  guard: guard(),
});
if (candidate.ok) {
  await tools.execute('visualization_commit', {
    candidateId: (candidate.data as { candidateId: string }).candidateId,
    guard: guard(),
  });
}
```

The snippets show the JSON protocol; TypeScript hosts should narrow the intentionally generic result `data` to the selected tool's response shape. `visualization_inspect` returns current guards, quantities and at most 20 points per series. Use `includeDocument:true` to fetch the complete accepted or tool-created candidate document. `visualization_save` returns a complete artifact, including retained comparison definitions. Store it through your application's persistence layer. `visualization_restore` rejects incompatible runtimes and altered definitions atomically.

Parameters start a new run at zero. Presentation edits preserve scientific state. Preview parameters remain tentative and block save, candidate operations, selection and playback until commit or cancellation. Guards cover session, accepted version and active run. Identical retries return the original result for the latest 64 retained operation IDs, including concurrent retries and relative `step` operations. Reusing an ID with different arguments fails. A cancelled operation must be retried with a fresh ID; the first request owns cancellation for an identical in-flight retry. Atomic commits that already completed cannot be undone by a later cancellation.

Discovery returns the actual document JSON Schema, document limits, expression functions and limits; pass `includeSchema:false` to omit the schema from a compact repeat discovery.

The default limits are 8 retained candidates, 10 runs including the active run (oldest comparisons are also evicted above a 3.3 MB aggregate comparison budget), 100 edits per batch, 4 MB per tool input, 64 requested quantity IDs and 20 returned diagnostics. Document, expression and dataset limits are additionally enforced by core. Limits are resource bounds, not performance guarantees. Authored expressions execute in a browser worker; importing this package on a server does not access DOM or storage. There is no implicit session singleton.

## Explicit server/browser transport

```ts
import { createSessionRelay, createBrowserToolEndpoint } from '@experiment-kit/agent';

// Server: principal must come from verified application authentication.
const relay = createSessionRelay({
  authorize: (principal, sessionId, operation) =>
    applicationACL.allows(principal, sessionId, operation),
});
const connection = await relay.connect({
  principal: authenticatedUserId,
  sessionId: authorizedBrowserSessionId,
  expiresAt: Date.now() + 15 * 60_000,
  send: envelope => authenticatedSocket.send(JSON.stringify(envelope)),
});
// Feed authenticated browser replies into connection.receive(envelope).
// On socket close: connection.disconnect().

// Browser: one endpoint owns exactly one session.
const endpoint = createBrowserToolEndpoint({
  sessionId: session.id,
  tools,
  send: envelope => browserTransport.send(envelope),
});
// Feed server messages into endpoint.receive(envelope).
// On transport close: endpoint.dispose(); reconnect with a new endpoint.
```

The server calls `relay.dispatch({principal, sessionId, requestId, name, input, signal})`. The host must derive principal and the authorized target independently of model arguments. Session IDs are identifiers, never authorization tokens. Authorization is rechecked on every call. Tool guards cannot redirect a call to another session. Each tab has its own session/connection.

Authorization and browser-response phases each have a 15-second default deadline. At most 16 authorization checks may wait concurrently across the relay and at most 16 browser calls may be in flight per connection. Cancellation and disposal release pending authorization waits; the host remains responsible for any underlying authorization operation it starts. Cancellation, timeout, expiry, reconnect and disconnect reject pending server calls and send browser cancellation when possible. Pending calls with the same correlation ID and payload deduplicate; completed correlation IDs cannot be reused. Use a new correlation ID and the same operation ID when retrying after a transport interruption. Each connection remembers up to 1,024 completed IDs and then requires reconnecting. Late replies from replaced connections are ignored. Dispose the relay and browser endpoints on application teardown.

The repository's `examples/host-relay` demonstrates the explicit HTTP boundary with a local scripted tool caller. Automated transport compatibility and scripted workflows are **not** evidence that a real LLM integration, unfamiliar developer pilot or independent security review has passed. Scene SVG export belongs to `@experiment-kit/player`; full-page capture requires a host adapter or separate browser automation. No screenshot capability is implied by these tools.

## Study Harness activity tools

`createActivityTools(context)` returns twelve policy-scoped, task-oriented tools for one host-authorized activity of the `@experiment-kit/activity` adapter: `activity_discover`, `activity_describe_template`, `activity_prepare`, `activity_inspect`, `activity_propose_revision`, `activity_request_reveal`, `activity_operate`, `activity_summarize`, `activity_save`, `activity_restore`, `activity_close` and `activity_sample`. The host constructs the context (adapter, catalogue, policy source, host session, activity, policy revision, audience, granted operations, the tutor binding and optional host routing); tool input can never choose an actor, origin, principal, session, activity or review status.

```ts
import { createActivityTools } from '@experiment-kit/agent';

const tools = createActivityTools({
  adapter, catalog, policy: () => hostPort.getPolicy({ activityId }),
  hostSessionId, activityId, policyRevision: policy.revision, audience: 'tutor',
  allowedOperations: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'summarize', 'save'],
  lifecycle: {
    request: () => ({ objectiveIds, hostSessionRevision }),
    bind: prepared => ({ binding: prepared.binding('tutor', 'tutor-tools'), host: prepared.host }),
  },
});
const discovered = await tools.execute('activity_discover', {});
// Every result is {ok:true,data,scope} or {ok:false,diagnostics}; scope separates technical validation, review scope and activity status.
```

Effective operations are the host grant ∩ `policy.allowedTools` (∩ the independent task's permitted tools). Each executor rechecks the bound policy revision and its operations before starting, after every await and before its commit; a committed step is never undone and reports when its authorization is no longer current. Expected revisions in input are guards, never permissions. Learner-visible inspection returns exactly the learner projection; full scientific state and isolated sampling require explicit teacher or tutor inspection policy and are never cached. Diagnostics use a fixed vocabulary with repair hints that never suggest bypassing a guard. `createActivityRelay` and `createActivityToolEndpoint` carry the tools between the host and the learner WebView with host-authenticated principal bindings and operation identity preserved across cancellation and reconnects.

Guide, scope model and repair cases: [`docs/study-harness/agent-tools.md`](../../docs/study-harness/agent-tools.md). Schemas: `docs/study-harness/activity-tool-schemas.json`. The scripted conformance sequence in `tests/agent/activity-trial.test.ts` is protocol evidence only; it is not an LLM trial and does not satisfy the real configured host-agent gate (G3 / A57). For that trial, `createTrialRecorder` wraps the activity relay and keeps a sanitized record (request IDs, tool names, outcome codes, fixed-vocabulary repairs, a configuration digest and budget usage; never inputs, results, text or keys); see section 7.1 of the guide.
