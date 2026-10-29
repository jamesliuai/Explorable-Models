# Explicit server/browser relay example

From the repository root:

```sh
npm run build:packages
node examples/host-relay/server.mjs
```

Open the **exact loopback URL printed by the server**. It includes a fresh local demo credential in the fragment. Select **Run scripted tool workflow**. A server-side deterministic caller discovers the public tools, creates a sine wave, adds a second curve and annotation, commits a parameter change, saves an artifact and restores it over the HTTP relay. The browser owns the worker and mounted surface; the server owns the authenticated principal, authorization map and caller.

This proves an explicit transport boundary. It is not a real LLM integration, an unfamiliar developer pilot, or production authentication. No provider credentials are used. The printed demo credential stays on the browser main thread and is never sent to the computation worker. The local server binds only to 127.0.0.1, checks Host/Origin, requires the credential on every API call, scopes each call to an authorized session, bounds bodies/queues/tabs and expires sessions after 15 minutes. Use `EXPLORABLE_MODELS_RELAY_PORT=0` for an automatically assigned port.

The browser transport uses authenticated long polling plus correlated POST responses. A production host can bind the same `createSessionRelay` and `createBrowserToolEndpoint` APIs to its authenticated WebSocket transport. Replace the demo principal/credential with your application's verified identity and resource authorization. Keep model credentials and provider calls on the server. Derive the target session from your application routing and authorization, never from a model's claim about its identity. Persist artifacts in your own storage. This demonstration retains its saved artifact in server memory only for the active scripted run.

The lower-level relay tests exercise cancellation, expiry, multiple tabs, replaced connections, late replies, correlation conflicts and unauthorized target attempts. Client controls and agent commands share the session version guards: changing the browser while a candidate is prepared causes a conflict rather than a stale overwrite. Reconnect the browser transport after interruption, inspect fresh guards, and use new correlation IDs with existing operation IDs only for exact request retries.

## Optional provider adapter (not credentialed-run verified)

`openai-agent.mjs` exports `runOpenAIAgent`, an optional server-only Responses API loop. It maps published tool schemas to function definitions, passes results back by call ID, preserves conversation continuity through `previous_response_id`, and fixes the authorized principal/session in host code. It uses built-in `fetch`, so no provider SDK enters the consumer dependency graph. The schema is explicitly non-strict because document fields are flexible; the toolkit validates every received tool input.

This integration follows the official [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling), consulted October 22, 2026. Choose a model available to your account explicitly; no model or cost assumption is baked into the example. Pass your server's secret and model as arguments, never in a document, browser bundle, log, or tool result. The loop enforces a turn/output budget and accepts an AbortSignal. Calling it makes billable provider requests. The demo button continues to run only the deterministic local caller.

A host server can replace its scripted handler with:

```js
import { runOpenAIAgent } from './openai-agent.mjs';
const result = await runOpenAIAgent({
  prompt: authenticatedRequest.prompt,
  relay,
  principal: authenticatedUser.id,
  sessionId: authorizedBrowserSession.id,
  model: process.env.OPENAI_MODEL,
  apiKey: process.env.OPENAI_API_KEY,
  signal: requestAbortSignal,
});
```

The adapter has mocked transport tests; no credentialed OpenAI run is recorded. It is therefore integration scaffolding, not evidence that the real-agent release gate passed. Register actual run configuration, tools, outcomes, token usage and human interventions in the external trial record before making a compatibility claim.
