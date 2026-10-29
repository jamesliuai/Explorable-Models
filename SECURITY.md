# Security boundaries

This page states what each part of the repository protects against, what it does not, and how to report a problem.
The current subsystem's threat model comes first. The earlier toolkit boundaries still apply to the source-authoring
CLI and the schema 2.0 declarative player.

## Study Harness visualization subsystem (0.3.0-preview.1)

This section covers `@explorable-models/activity`, `@explorable-models/catalog`, `@explorable-models/player/activity`,
`@explorable-models/player-3d`, the activity tools in `@explorable-models/agent`, and the packaged reference host
`examples/study-harness-tauri`. The specification is report §16.

### Supported threat model

The supported model is **trusted bundled rendering code handling untrusted declarative data**. The following are
trusted:

- the repository's packages;
- the installed catalogue kernels, which are pure repository code bundled into the catalogue worker;
- the host application that constructs the adapter.

Everything else is data and is validated before use:

- activity requests, host messages and imported artifacts;
- scene and learner text, and TeX;
- agent tool input;
- schema 2.0 exploratory documents;
- review claims found inside any of these.

Running arbitrary executable content (generated JavaScript, remote plugins, agent-selected modules) is **not
supported**. Supporting it would need a separately designed unprivileged execution boundary. Moving generated code
into another component does not isolate it.

### Untrusted data

- **Contracts.** Every `study-harness.*` record rejects unknown fields and bounds every string, array, map and number.
  `validateRecord` applies byte, depth and node limits before it walks a schema. It rejects accessors, cycles, class
  instances, non-finite numbers and `__proto__`, `prototype` and `constructor` keys.
- **Diagnostics.** Messages are fixed text, and paths keep only identifier-shaped keys, so input values are never
  echoed. Errors shown to learners use a fixed vocabulary and never name hidden content.
- **Text and math.** Learner-visible text is rendered as text, never as HTML. KaTeX runs with `trust: false` and
  bounded expansion and size. Sources are capped at 4096 code points. Macro definitions and resource or HTML commands
  (`\def`, `\href`, `\url`, `\includegraphics`, `\htmlClass` and similar) are rejected before KaTeX sees the source.
  Rendering goes into DOM nodes, never through `innerHTML`.
- **Theme tokens.** Host tokens must be literal colours or bounded lengths. Anything else is ignored and reported.
- **Learner runtime.** There is no `eval`, no dynamic function construction, no agent-selected import, no shell and no
  compiler. Requests carry IDs and data only. An agent or imported record cannot name a path, URL, module, loader or
  worker. Remote assets are not used.
- **Review authority.** Review status comes only from the host-constructed review registry, bound to exact digests.
  Review-like fields in templates, manifests, artifacts or agent input are ignored. A hash establishes identity, not
  correctness.

### Workers

Workers isolate model evaluation from the DOM and give the runtime a way to terminate it. They are **not a hostile-code
security boundary and not a memory quota**. The runtime therefore:

- bounds payloads before deep traversal;
- validates every frame twice, in the worker and on the main thread, against declared shapes and limits;
- caps queues (one active preview evaluation plus one newest queued value per activity, and a shared worker budget);
- terminates a worker after a 5-second watchdog or a protocol violation;
- discards late and stale replies.

Authored kernels and checks from the authoring CLI are candidate code. Node only parses and bundles them, and they run
only in browser workers ([authoring](docs/study-harness/authoring.md)).

### Authority

- **Construction context.** The host constructs the adapter with its `HostPort`. Actor attribution (`learner`, `tutor`,
  `host`) is fixed by the binding the host created. No command field can choose an actor, origin, principal, session,
  activity or review status.
- **Receipts.** A receipt is accepted only as the resolved value of the host call made for that exact request. A
  receipt that does not match is refused before anything is displayed.
- **Policy.** Stale, revoked or expired policies fail before any reveal or mutation.
- **Agent tools.** Tools reject authority fields with a repair hint and recheck the bound policy revision after every
  await.

### Native command scope

- **Package imports.** The visualization packages import no Tauri API, filesystem library, provider client or
  credential store. `tests/activity/boundaries.test.ts` enforces this on the import graph.
- **Host callbacks.** The host supplies narrow typed callbacks (`HostPort`) that take activity IDs, receipts and
  bounded artifacts, never paths or generic commands.
- **Reference host commands.** The host registers 22 production commands: the nine `HostPort` methods plus narrow
  host-owned operations. Each command:
  - takes a raw request body (JSON-object invocations are refused);
  - checks the byte length before parsing;
  - validates the body against the shared JSON Schemas in Rust (`packages/activity/rust`);
  - returns fixed `{ code, message }` errors.
- **Permissions.** Registering a command with `invoke_handler` does not restrict who can call it. The application
  manifest lists only production commands, and the main-window capability grants exactly those. No core or plugin
  permission is granted: no path, filesystem, shell, HTTP, dialog or window access.
- **Test commands.** Test-only commands and crash points exist only in the separate `conformance` feature build. The
  release binary is checked for their absence ([native.md](docs/study-harness/native.md) N7–N8).
- **Credentials.** No command returns a provider key. The reference host stores no credentials.

A React component or a shadow root inside a shared WebView is not a native permission boundary.

### Content security policy

These rules are tested in the packaged macOS WKWebView ([native.md](docs/study-harness/native.md) N1–N6):

- The production policy is `default-src 'none'`, with self-only scripts, styles, fonts, connections and workers;
  `img-src 'self' blob:`; and no `'unsafe-eval'` or `'unsafe-inline'`.
- Worker scripts receive their own policy.
- `blob:` and inline workers are not used.

The browser integration fixture and the dev server set no CSP and are not CSP evidence. The legacy schema 2.0 player's
tested policy still allows scoped inline styles; see [embedding](docs/embedding.md#workers-ssr-and-csp).

### Privacy, logging and telemetry

- **No telemetry.** There is no analytics client, telemetry upload, provider call or credential in any package. The
  subsystem works with all external network access blocked. The reference host's release binary is checked for open
  sockets.
- **The journal is a study record.** The interaction journal, exposure records and artifacts belong to the user's
  study record, not to a telemetry feed. The host owns their storage, retention, export and deletion. `forget()`
  releases the adapter's cached copies after the host deletes data.
- **Policy-filtered outputs.** Learner snapshots, captures, summaries and learner-scoped tools receive only the
  learner projection. Hidden quantities, solution groups and host-only records are left out.
- **Capture scope.** Captures cover one surface's view, never unrelated page, chat or desktop content.
- **Diagnostics.** Diagnostics are local callbacks. Keep learner text, source extracts, private assessment data and
  keys out of ordinary logs.
- **Portable backups.** Backups written by the reference host contain the host's full records, including response
  text. Treat them as the learner's study record. On import the reference host treats the file as untrusted data:
  every table has a fixed column list taken from its store schema, and statements are built only from those lists.
  Before any SQL runs, keys must match exactly and values must have fixed shapes. A file that fails is refused and
  changes nothing.

### Evidence and limits

Automated misuse tests cover:

- prototype keys, accessors, cycles and oversized input (`tests/activity/contracts*.test.ts`);
- disclosure through every learner channel and through errors (`tests/activity/disclosure.test.ts`);
- hostile TeX (`tests/player-activity/math.test.ts`);
- forged or stale receipts and review records (`tests/activity/exposure.test.ts`, `tests/catalog/`);
- authority fields and cross-session calls through the tools and relay (`tests/agent/activity-*.test.ts`);
- the native raw-body, size-bound, schema and ACL rejections (packaged conformance probes).

These are engineering checks. **No independent human security review** of the data path or the native commands has
taken place. The reference host is a conformance fixture. Its builds are not code-signed or notarized, and it is not a
production authentication or storage design.

## Toolkit boundaries (0.1 source authoring and 0.2 declarative preview)

Version 0.1 is for trusted local authors and static playback of trusted bundles. It does not accept public uploads or
claim a Web Worker is a hostile-code sandbox.

The CLI:

- uses toolkit-owned compilation;
- disallows candidate build scripts, build configuration and remote imports;
- bounds source and output sizes and validates paths;
- never imports authored models or checks into privileged Node.

Models run in a browser worker with a timeout. Candidate failure preserves the working bundle.

The optional live coordinator:

- binds only to loopback and uses a per-session token;
- checks origins and routes to explicit session IDs;
- keeps tokens outside model-worker APIs;
- contains served paths after symlink resolution.

Stale commands cannot overwrite a newer learner action.

Static exports contain only allowlisted source and bundled dependencies. There is no analytics client, model API
credential, private chat export, account service, or external font dependency. Serve exports over HTTP, and inspect
their asset and source manifests to audit their contents.

Keep the dependency lockfile pinned. `npm audit` is a useful dependency signal but is not proof of application
security. Public hosting of arbitrary source requires a separate isolated execution origin and build service.

The 0.2 declarative preview accepts a bounded JSON grammar, interpreted in a dedicated browser worker, rather than
arbitrary uploaded code. Inputs, worker replies, rendering bindings, relay targets, and artifacts are validated and
resource-limited. Automated misuse tests and separate-agent review are recorded; independent human security review
remains open. Do not deploy the local demo credential scheme as production authentication.

## Reporting

Report security problems privately to the repository maintainers before public disclosure. Do not attach credentials
or unrelated private files to reports, and do not put sensitive vulnerability details into public issues.

The source repository is [jamesliuai/Explorable-Models](https://github.com/jamesliuai/Explorable-Models). A private
reporting destination is still pending: the owner must establish and test an actual email or reporting URL before
package or website publication. The repository link and the instruction above are not evidence that a private
reporting channel exists. Track this handoff in `publication.config.json` and `docs/public-preview-handoff.md`.
