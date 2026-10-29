# Agent-first preview contract

> **Historical: the 0.2 declarative preview contract.** This page records the `0.2.0-preview.1` candidate as it was
> prepared on 22 October 2026. The workspace is now `0.3.0-preview.1` (unreleased), which adds the Study Harness
> visualization subsystem and its separate `study-harness.*` 1.0 contracts. The schema 2.0 document contract described
> here is unchanged, and so is document runtime `0.2.0-preview.1`. The package list and release statements below
> describe the 0.2 candidate only. For current behaviour, see the [README](../README.md), the
> [Study Harness handoff](study-harness/README.md), [embedding](embedding.md), the
> [compatibility matrix](study-harness/compatibility.md) and the [changelog](../CHANGELOG.md).

Candidate: `0.2.0-preview.1`. Document schema: `2.0`. This is a limited developer preview, not the supported release defined by the release plan. Public package names are provisional until registry ownership is confirmed. Legacy schema `1.0` and runtime identities remain separate.

The product is an embedded 2D explanation toolkit. The host supplies authentication, application navigation, data loading, an agent connection if desired, and persistence. The toolkit supplies a bounded document grammar, worker evaluation, guarded instance state, safe rendering, and provider-neutral tools. No account, tutoring, assessment, model subscription, or telemetry service is included.

## Public boundaries

| Entry | Purpose | Import environment |
| --- | --- | --- |
| `@experiment-kit/core` | Existing 1.0 model/runtime contract | Node or browser; authored code still runs in workers |
| `@experiment-kit/core/declarative` | 2.0 documents, session, presets, limits, validation | Import is SSR-safe; default session construction needs browser Worker |
| `@experiment-kit/player` | React surface, imperative mount, supported scene export | Import is SSR-safe; mounting is client-only |
| `@experiment-kit/agent` | Tool descriptors, executor, scoped relay | Host-neutral; execution targets an authorized browser session |
| Legacy CLI | Trusted local TypeScript compilation, MCP, full-surface capture/export | Node plus Chromium |

2D consumers must not load Three.js, the CLI compiler, Playwright, or a model-provider SDK. The player uses React and ReactDOM as peer dependencies, including for its imperative DOM API. The plain-DOM API means no React code is required from the host; it does not mean the runtime is dependency-free.

## State transitions

| Operation | Run and time | Revision and failure behavior |
| --- | --- | --- |
| Parameter commit | New run, time zero | Old run retained within limits; invalid parameters preserve accepted state |
| Expression/data/binding/coordinate revision | New run, time zero | Candidate validates before atomic acceptance |
| Styling/label offset/layout/precision | Preserve run, parameters and time | New presentation and full document identity |
| Preview gesture | Accepted frame unchanged | Explicit tentative state; commit or cancel before export |
| Seek | Same run, clamped at exact terminal time | Worker computes boundary quantities; velocity is not forced to zero |
| Restore | New run with original provenance | Validate complete artifact and exact identities before replacement |
| Failed/cancelled/stale edit | Preserve accepted state | Structured diagnostic; fresh inspection and operation ID allow recovery |
| Dispose | Terminal session state | Worker, timers, candidates and subscriptions released |

Every mutation uses session ID, expected state version, expected active run ID when present, and an operation ID. Session IDs are routing identifiers, never authorization. Playback advances do not invalidate a presentation candidate merely by advancing time. Operation IDs provide bounded retry deduplication, not permanent exactly-once storage. Do not reuse them for different arguments.

## Expression and data scope

Expressions are parsed, allowlisted, bounded, and interpreted in the browser worker. No JavaScript evaluation, ambient network, global lookup, property access, dynamic imports, or arbitrary event handlers are accepted. Public model constants and coordinates are quantities, not renderer calculations. Declared data snapshots are immutable inputs; changing data changes model identity.

Scientific unit labels are display metadata. The explicit `dimension` field participates in the documented supported dimension checks; omission does not establish scientific units. Unsupported symbolic reasoning, automatic conversion, affine temperatures, unrestricted vector algebra, statistical inference, numerical integration, and stochastic execution are outside this preview. Trigonometric arguments use radians; degree conversion must be explicit in model expressions.

Null data cells remain missing. Undefined computations have status and reason. Series never connect through a missing sample. Uniform sampling cannot detect every mathematical discontinuity between samples; authors must split domains at known discontinuities. Fixed view bounds prevent silent rescaling during animation; coordinates outside them clip visibly. Equal aspect is the scientific-scene default. Label offsets are manual; universal collision avoidance is not claimed.

## Compatibility and support

Schema 2.0 import rejects legacy 1.0 snapshots. Keep original immutable 1.0 export bundles and use the legacy player to reopen them. There is no silent migration or relabeling of old check reports. An exported v2 document includes exact identities, runtime version, current run and retained comparison definitions; retention is bounded, so hosts must save durable artifacts themselves.

Supported automated baseline is the pinned Chromium on macOS in the local evidence record and Linux in configured CI. Firefox/WebKit critical flow runs are recorded separately when available. Actual Safari and real mobile hardware remain unverified until explicitly recorded; a mobile viewport is not a device test. Browser Worker, ES2022, Web Crypto, and a secure context (or localhost) are prerequisites. Serve over HTTP(S), not `file://`.

## Frozen benchmark workloads

Record platform, browser version and package hashes with each run. Workloads are: two simultaneous wave documents; a 1,001-sample plot and linked values; a 100-mark scene; a dataset at the documented row limit; and 25 mount/edit/dispose cycles. Measure p50/p95 commit latency after warmup, startup separately, worker and page errors, and retained sessions. A target of p95 below 100 ms is a target until measured; process memory or one heap sample does not prove stabilization. Initial bundle budgets are set from the first packed measurement and maintained in the package evidence script.

No automated result here is scientific peer review, accessibility certification, learning efficacy evidence, or proof of an authoring advantage. The full release gate remains in [the release plan](agent-first-release-plan.md).
