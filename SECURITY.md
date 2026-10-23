# Security boundaries

Version 0.1 is for trusted local authors and static playback of trusted bundles. It does not accept public uploads or claim a Web Worker is a hostile-code sandbox.

The CLI uses toolkit-owned compilation, disallows candidate build scripts/configuration and remote imports, bounds source/output sizes, validates paths, and never imports authored models/checks into privileged Node. Models run in a browser worker with a timeout. Candidate failure preserves the working bundle.

The optional live coordinator binds only to loopback, uses a per-session token, checks origins, and routes to explicit session IDs. Tokens stay outside model-worker APIs. Stale commands cannot overwrite a newer learner action. Served paths are contained after symlink resolution.

Static exports contain only allowlisted source and bundled dependencies. There is no analytics client, model API credential, private chat export, account service, or external font dependency. Serve exports over HTTP; inspect their asset/source manifests to audit contents.

Keep the dependency lockfile pinned. `npm audit` is a useful dependency signal but is not proof of application security. Public hosting of arbitrary source requires a separate isolated execution origin and build service.

Report security problems privately to the repository maintainers before public disclosure. Do not attach credentials or unrelated private files to reports.

## Declarative preview boundary

The 0.2 preview accepts a bounded JSON grammar, interpreted in a dedicated browser worker, rather than arbitrary uploaded code. Inputs, worker replies, rendering bindings, relay targets, and artifacts are validated and resource-limited. Automated misuse tests and separate-agent review are recorded; independent human security review remains open. Do not deploy the local demo credential scheme as production authentication.

The source preview is available at [jamesliuai/Explorable-Models](https://github.com/jamesliuai/Explorable-Models). A private reporting destination is still pending: the owner must establish and test an actual email or reporting URL before package/website publication. The repository link and the general instruction above are not evidence that a private reporting channel is enabled. Do not put sensitive vulnerability details into public issues. Track this handoff in `publication.config.json` and `docs/public-preview-handoff.md`.
