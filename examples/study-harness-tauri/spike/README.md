# W12 native feasibility spike (archived sources)

These are the sources of the early macOS feasibility spike whose results are recorded in
[`docs/study-harness/evidence/native-spike.md`](../../../docs/study-harness/evidence/native-spike.md) and
`native-spike.json`. They are kept for provenance only.

They are **not** part of the reference host: nothing here is built, bundled or packaged. The spike's test-only
scaffolding (`SH_SPIKE_OUT`, the auto-exit after the report, the 45 s watchdog and the deliberately ungranted
`spike_forbidden` command) was removed from the release path. Its probes are re-established against the actual learner
card by the packaged conformance build (`--features conformance`, `vite --mode conformance`); see the
[reference host README](../README.md) and `docs/study-harness/evidence/native-conformance.md`.

`scripts/run-spike.mjs` targeted the spike's own `src-tauri` layout and no longer runs against the reference host.
