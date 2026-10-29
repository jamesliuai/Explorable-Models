/**
 * Activity artifacts (report §14 and §19, activity-runtime §9, A48/A49 data side). Two export paths share the 1.0
 * contract: a host-owned `backup` with everything needed to restore, and a policy-filtered `learner-snapshot` that
 * holds only what the caller's learner projection exposes (no exposure evidence, review or response records, journal
 * internals or unrestricted document). A pending preview is recorded in `pending` and never as the saved scientific
 * state. Verification checks size before traversal, then schema, semantics and integrity, and never trusts a saved
 * claim of independence, visibility or approval: {@link restoreClaims} lists what must be re-derived from the host.
 */
// The public helpers remain synchronous. Internal callers use the narrow build/read entry so a prepare/save
// consumer does not eagerly retain the optional restore codec in a shared bundle chunk.
export * from './artifact-build.js';
export * from './artifact-read.js';
