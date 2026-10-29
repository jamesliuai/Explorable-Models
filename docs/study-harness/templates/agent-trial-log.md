# Host-agent trial log (template)

Fill one log per run of the G3 sequence (external gate G3, requirement A57): a real configured trial through the
actual Study Harness agent path, with owner-supplied provider credentials, a pinned model configuration and a bounded
budget supplied by the host. The machine-readable form is
[`agent-trial-record.schema.json`](agent-trial-record.schema.json) (`study-harness.agent-trial-record/1`), produced by
the opt-in recorder in `@explorable-models/agent` (`createTrialRecorder`, see `docs/study-harness/agent-tools.md`).

**What this log may contain:** request identifiers, tool names, outcome codes, fixed-vocabulary repairs, the G3 step
each request evidences, the provider and pinned model identifiers, a digest of the configuration, and numeric usage
against the budget. **What it must never contain:** provider keys or tokens, tool inputs or results, learner text,
study content, prompts or model output. The recorder enforces this for the JSON record; keep the prose fields below
equally free of it.

**Label the run honestly.** Only a run through the actual Study Harness agent path is `real-agent-trial`. The scripted
conformance sequence in `tests/agent/activity-trial.test.ts`, mock transports and fixture hosts are
`scripted-fixture`: useful protocol evidence that never satisfies A57.

## Run identity

| Field | Value |
| --- | --- |
| Trial ID | |
| Kind (`real-agent-trial` / `scripted-fixture`) | |
| Date | |
| Host application, commit and executable sha256 | |
| Platform | |
| Provider identifier and pinned model identifier | |
| Configuration digest (`configuration.digest` from the record) | |
| Budget (max requests, tokens, cost and currency) | |
| Budget used (from `totals`) and `withinBudget` | |
| Packed `@explorable-models/*` tarball sha256 set | |

## G3 sequence

Every step needs at least one recorded request ID (the record's `steps` map). An outcome code is the tool's
diagnostic code (for example `POLICY_DENIED`, `STALE_ACTIVITY_REVISION`) or `ok`; a repair is one of
`refresh-guards`, `adjust-value`, `drop-parameter`, `request-stage-change`, `retry-same-operation`, `new-operation`,
`decline-with-alternative`, `other`.

| Step | Request IDs | Outcome codes | Repair (kind, of request) | Completed? |
| --- | --- | --- | --- | --- |
| `discover` an approved activity | | | | |
| `personalise` allowed parameters while preparing | | | | |
| `inspect` learner-visible state | | | | |
| `rejected-request` (out-of-domain parameter or forbidden reveal) | | | | |
| `repair` of the rejected request | | | | |
| `host-reveal` requested through the host | | | | |
| `summarise` the interaction | | | | |
| `save` | | | | |
| `reopen` | | | | |
| `stale-operation` handled (expected revision mismatch) | | | | |
| `unsupported-declined` with the advertised alternative | | | | |

## Outcome

Pass condition (docs/study-harness/external-gates.md G3): every step completed, rejections handled without guard
bypass, results recorded. Note any defect, guard bypass attempt or budget overrun:
