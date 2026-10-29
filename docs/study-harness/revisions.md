# Revision spaces and guards

Four revision spaces have different meanings (report §4.2). Commands that cross a boundary carry the expected
revisions they depend on, plus an `operationId`. Routing IDs, `origin` strings and agent-supplied fields are not
authorization; authority comes from the binding the host constructed (architecture D5).

| Space | Identity / counter | Owner | Advanced by | Guard on commands |
| --- | --- | --- | --- | --- |
| Scientific | model `digest` + `scientificRevision`; run ID; `ModelSession.version` | `@explorable-models/core/model` session | load, parameter commit, scenario, reset experiment, restore (new run); navigation (version only) | `expectedScientificVersion`, `expectedRunId` |
| Presentation | `PresentationSnapshot.revision` | activity controller | camera, reset view, selection, layout, display unit | `expectedPresentationRevision` |
| Activity | `ActivityInstance.activityRevision`; template `digest` and group content digests | host-authorized via receipts | only values carried by verified receipts: stage transition, reveal, exploration scope, assistance (host-local changes never advance it: response references are guarded by the host-session revision, policy updates and the independent context by the policy revision; close takes no revision guard) | `expectedActivityRevision`, `expectedPolicyRevision` |
| Host session | `hostSessionRevision` | Study Harness host only | attempts, corrections, disputes, deletion: the host passes the revision its transaction produced (`hostSessionRevision` on response references; `observeHostSessionRevision` for changes made elsewhere); the adapter adopts it and never computes one | `expectedHostSessionRevision` (response references, `observeHostSessionRevision`) |

## Effects and non-effects (tested by `tests/activity/revisions.test.ts`)

| Change | Scientific | Presentation | Activity | Host |
| --- | --- | --- | --- | --- |
| Commit parameters / scenario / reset experiment | new run at index/time 0; version +1 | unchanged | unchanged (event recorded) | unchanged |
| Navigate index/time, step | same run; version +1 | unchanged | unchanged | unchanged |
| Playback tick | same run; version unchanged | unchanged | unchanged | unchanged |
| Camera, selection, layout, display unit | unchanged (run, index, version) | +1 | unchanged | unchanged |
| Reveal / stage transition (with host receipt) | unchanged | unchanged | set to receipt's revision | unchanged |
| Template content or explanatory label edit | unchanged if model identical | — | new template digest → needs new authorization; prior approvals do not transfer | unchanged |
| Model meaning edit (units, sign convention, assumption, declared coordinate units) | new `scientificRevision` → new model identity, new run | — | template must reference the new model; approvals invalidated | unchanged |
| Model explanatory edit (summary, parameter description or symbol, quantity symbol, geometry or dataset description, constraint message, or the wording of the title or of any parameter, quantity, geometry, dataset or column label — a reworded, swapped or recapitalized label) | new `scientificRevision`: the model review no longer applies (`tests/core/model-identity.test.ts`, `tests/catalog/catalog.test.ts`) | — | template must reference the new model digest; approvals invalidated | unchanged |
| Model label or title respelling that keeps the wording (white space, quotation-mark style, Unicode composition, a hyphen or en dash joining two words of three or more letters; `labelWording`), or a UI step increment | unchanged (`presentationRevision` changes; the digest changes, so templates still re-bind; `tests/core/model-identity.test.ts`) | — | template must reference the new model digest | unchanged |
| Response submitted / corrected | unchanged | unchanged | unchanged (guarded by host-session revision) | host-advanced: the adapter checks the expected value and adopts the host's new value (greater than the expected one) |

Label wording versus label spelling (report §8.3, R38). A quantity label is the learner's readout name and a column
label is a table header, so what a label says is part of what a model review approves. `labelWording` (in
`@explorable-models/core/model`) removes only variation a mechanical rule can certify as harmless: white space (including
no-break and thin spaces), curly versus straight quotation marks, Unicode canonical composition, and a hyphen or en dash
joining two words of three or more letters ("Step-size" = "Step size"). Everything else changes the scientific revision,
including a capitalization change or a corrected typing error, because no rule can tell them from a meaningful change:
"Height" → "Weight" is one letter, and case distinguishes coefficients, prefixes and units ("a"/"A", "mm"/"Mm"). Such
an edit needs a new review; that is the conservative side. The labels and titles inside an embedded schema 2.0 document
stay presentation, because no model or activity channel reads them (frames carry values; learner channels name inputs
and outputs from the manifest and the template).

Display layers are reserved in 1.0: `PresentationSnapshot.views[*].layers` exists, but the 1.0 activity template
declares no display layers, so no command sets them, the controller always writes `layers: []`, and a restore clears
saved layers with a note (a saved layer can never re-enable a forbidden group; A38). A template version that declares
layers would add a presentation-guarded command limited to the declared layers of visible groups.

Undo is not offered: the activity binding has no undo command, so no run is created by an undo. The `undo` value of the
`parameters.committed` cause in the 1.0 event and summary schemas is reserved and never produced; a later undo would
have to commit the earlier parameters as a new run with `previousRunId` provenance and leave exposure records unchanged
(report §9, A19).

A presentation-only edit can still change instructional assistance (report §6.2): explanatory labels, highlights and
substituted equations belong to content groups bound by digest, so adding them requires a new activity
authorization and exposure record even though the scientific run is preserved.
