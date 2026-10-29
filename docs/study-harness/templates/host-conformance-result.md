# Host conformance result (template)

Fill one result per run of the G2 conformance sequence (external gate G2, requirement A54). The machine-readable
form is [`host-conformance-result.schema.json`](host-conformance-result.schema.json) (`study-harness.host-conformance-result/1`).
A filled result is evidence only for the host, commit, binary and platform it names.

The HostPort conformance kit (`runHostPortConformance` from `@experiment-kit/activity/conformance`, see
[external gates G2](../external-gates.md#g2-actual-study-harness-integration-a54)) produces this record directly
(`run.result`) and names itself in the optional `kit` field. A host that runs the sequence with its own harness fills
the same form and omits `kit`. Optional fields: a step's `reason` says why it did not run or failed (for example a hook
the host did not provide); an assertion's `detail` says why it failed or did not run (fixed text with codes and counts,
never learner data).

**Label the subject honestly.** `actual-host` means the Study Harness application with its own core, persistence,
policy and agent connection. Runs against the packaged reference host (`reference-fixture-host`) or an in-memory host
(`memory-fixture-host`) are fixture results: keep them, but they never satisfy A54. Keep learner data, study content
and credentials out of this record.

## Run identity

| Field | Value |
| --- | --- |
| Subject (`actual-host` / `reference-fixture-host` / `memory-fixture-host`) | |
| Run time (ISO 8601) | |
| Host name | |
| Host source commit (and whether the working tree was dirty) | |
| Executable sha256 (the binary that ran) | |
| Signed build? | |
| OS, version and architecture | |
| WebView (WKWebView / WebView2 / WebKitGTK) and version | |
| Packed `@experiment-kit/*` tarballs mounted: name, version, sha256 (from `release/study-harness/packages/manifest.json`) | |

## Sequence

Outcome is one of `pass`, `fail`, `not-run (environment)` (with the reason, for example a locked console or hidden
window for display-dependent checks) or `not-run`. A step that was not run is never recorded as passed.

| Step ID | Step | Outcome (and reason when not passed) | Assertions (ID: outcome, detail when not passed) | Evidence reference |
| --- | --- | --- | --- | --- |
| `open-quadratic` | Open the quadratic activity from the approved catalogue through the host | | | |
| `prediction-reference` | Record the learner prediction as a host response reference | | | |
| `authorize-reveal` | Authorize and reveal the next stage; intent and display acknowledgement persisted before the content shows | | | |
| `commit-exploration` | Commit an exploration parameter change (new run at index zero) | | | |
| `camera-change` | Change the presentation (camera or layout) without a scientific change | | | |
| `save` | Save the activity artifact through the host store | | | |
| `terminate` | Terminate the application process | | | |
| `reopen-verify` | Reopen; verify scientific state, permitted presentation, event order and conservative exposure | | | |
| `independent-task` | Start an independent task: no teaching visual; late reveals discarded | | | |
| `crash-before-intent` | Terminate before the exposure intent is persisted; reopen shows the content unseen | | | |
| `crash-after-intent` | Terminate after the intent is acknowledged, before display; reopen records authorized, not displayed | | | |
| `crash-after-display` | Terminate after display, before the display acknowledgement is persisted; reopen records it uncertain (conservatively exposed) | | | |

## Result

`pass` only when every step and assertion passed; `incomplete` when any step was not run; otherwise `fail`.
List limitations (for example: network not disabled, one platform only, unsigned build).

| Result | Limitations |
| --- | --- |
| | |

## JSON skeleton

```json
{
  "schema": "study-harness.host-conformance-result/1",
  "subject": "actual-host",
  "runAt": "",
  "host": { "name": "", "commit": "", "dirty": false, "binarySha256": "", "platform": { "os": "macOS", "osVersion": "", "arch": "arm64", "webview": "" } },
  "packages": [{ "name": "@experiment-kit/activity", "version": "0.3.0-preview.1", "sha256": "" }],
  "kit": { "name": "@experiment-kit/activity/conformance", "version": "0.3.0-preview.1" },
  "steps": {
    "open-quadratic": { "outcome": "not-run" }, "prediction-reference": { "outcome": "not-run" }, "authorize-reveal": { "outcome": "not-run" },
    "commit-exploration": { "outcome": "not-run" }, "camera-change": { "outcome": "not-run" }, "save": { "outcome": "not-run" },
    "terminate": { "outcome": "not-run" }, "reopen-verify": { "outcome": "not-run" }, "independent-task": { "outcome": "not-run" },
    "crash-before-intent": { "outcome": "not-run" }, "crash-after-intent": { "outcome": "not-run" }, "crash-after-display": { "outcome": "not-run" }
  },
  "result": "incomplete",
  "limitations": []
}
```

The skeleton is deliberately incomplete (empty commit, hashes and time): it does not validate until a real run fills it.
