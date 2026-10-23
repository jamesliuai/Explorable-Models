# Local preview operations and future release handoff

The owner selected a **source-repository developer preview** and authorized committing and pushing to `jamesliuai/Explorable-Models`. npm publishing, hosting, and external pilots remain deferred. The CI workflow builds and retains artifacts without publishing packages, deploying a website, or creating a GitHub Release.

## Reproduce the candidate

Use Node 22.12+ and the lockfile. Build the core/player/agent packages before consuming their declaration files. The release scripts never execute candidate model/check code in privileged Node.

```sh
npm ci
npx playwright install chromium firefox webkit
npm run typecheck
npm test
npm run test:browser
npm run test:cross-browser
npm run build
npm run verify:gallery
npm run build:packages
npm run verify:packages
npm run release:preview
```

Browser and CLI checks need local loopback-server access. A sandbox `listen EPERM` is an environment failure; rerun in an authorized local environment. Do not erase failing test evidence or replace a failing runtime assertion with a screenshot.

`release/preview/` contains the separate library tarballs, exact package integrity evidence, and a static site archive after `release:preview`. Source/CLI distribution remains available through `npm run release`; its package has compiler and browser dependencies and should not be used as the default website dependency.

Serve the `dist` directory over HTTP. `index.html` opens the studio, `agent.html` remains its alias, `gallery.html` opens the legacy gallery, and `guide.html` explains the preview. Existing `?experiment=…` links and v1 startup snapshots still open the legacy player. `npm run preview` is a local convenience. Check `dist/bundle-manifest.json` for asset hashes and separate v1/v2 runtime metadata. The site requires no agent credentials or third-party network access for playback. `npm run verify:artifacts` checks the exact packaged ZIP under a nested URL path.

## Support and troubleshooting

| Symptom | Diagnosis and recovery |
| --- | --- |
| Worker timeout only in a packed application | Confirm worker entry is preserved by tree shaking, served as JavaScript, and permitted by CSP. Use the explicit worker factory example. |
| Version conflict | A user or another operation changed accepted state. Inspect again and prepare a new candidate. Never overwrite guards blindly. |
| Save/capture says preview is active | Commit or cancel the tentative gesture; accepted state is intentionally protected. |
| SVG export says exact surface unavailable | Mount the surface, pause playback, and wait for the frame render; this API does not screenshot HTML. |
| Tiny error appears as zero in host UI | Use the provided formatter or an equivalent significant-value policy. Inspected values remain unrounded. |
| Source cannot be reopened | Verify schema/runtime/identities and full retained definitions. Use original legacy bundles for v1 snapshots. |
| Layout changes during drag | The renderer freezes the screen-to-model transform at pointer down. Keep host container lifecycle stable through the gesture. |
| Unexpected 3D/compiler weight | Import the public player entry, not the legacy gallery source. The packed consumer check enforces a 2D load budget. |

These items are based on implementation/automated integration observations, not reports from outside pilots. No default analytics or telemetry is added. Host applications control any diagnostic collection; avoid collecting documents, data, credentials or user identifiers without an explicit policy.

## Security reporting and publication prerequisites

The owner selected Explorable Models and `https://github.com/jamesliuai/Explorable-Models.git`; repository/issue/homepage links are configured. Hosting is deferred. Before package/website publication, confirm npm namespace ownership if publishing packages, configure a working private vulnerability-reporting channel, and supply a public maintainer/contact name. `npm run preflight:public` reports pending metadata, with `-- --packages` checking namespace confirmation too; it does not gate source commits. `SECURITY.md` is a process statement, not a working contact endpoint. See [the current handoff](public-preview-handoff.md).

The original code/presets remain MIT. Bundled legacy third-party notices are copied into the site. Tarball inventories exclude credentials, session bridges and unrelated local files. Advisory scanning supplements boundary tests; it is not independent security review.

## Publishing and rollback after the gates pass

1. Freeze the exact reviewed candidate, update the evidence record, and commit/tag it in the owner's chosen repository.
2. Rebuild from that tag in clean CI; compare manifests and package inventories, and retain immutable artifacts.
3. Confirm each npm package name is controlled by the intended owner. Publish the reviewed prerelease tarballs under a `preview` dist-tag first. Never overwrite an existing version.
4. Deploy the exact static archive to the chosen subpath. Run clean public-install and hosted playback/tool smoke checks. Record registry integrity, deployment URL and support contacts.
5. Only advance a supported/default dist-tag after the plan's mandatory gates pass. Document known limitations and affected versions.
6. On a serious regression, move the dist-tag back to the last known-good immutable version and restore the previous site deployment. Deprecate affected package versions with a concise reason, preserve artifacts for investigation, and publish a fixed new version with a regression test.

The rollback procedure is documented, not registry-tested in this local preview. No previous public version or deployment is asserted to exist.
