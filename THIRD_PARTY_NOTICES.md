# Third-party notices

Experiment Kit's original code and examples are MIT licensed. Scientific source references are linked from model cards; no textbook illustrations, restricted lesson text, or competitor source code is incorporated.

The exact dependency graph and integrity records are in `package-lock.json`. The release packages preserve upstream licenses. Direct dependencies include:

| Package | License | Role |
| --- | --- | --- |
| React, React DOM | MIT | Player interface |
| Vite, esbuild, TypeScript, tsx | MIT | Fixed authoring/build tooling |
| Three.js | MIT | Bounded 3D rendering |
| D3 scale, D3 shape | ISC | SVG plots |
| KaTeX | MIT (code and stylesheet); SIL Open Font License 1.1 (KaTeX fonts) | Visual mathematics and MathML |
| Lucide React | ISC | Interface icons |
| fflate | MIT | ZIP exports |
| Zod | MIT | MCP argument schemas |
| Model Context Protocol TypeScript SDK | MIT | Local stdio agent adapter |
| Playwright | Apache-2.0 | Browser execution and capture |
| Vitest | MIT | Automated tests |
| Inter / Fontsource variable Inter | SIL Open Font License 1.1 (the `@fontsource-variable/inter` 5.3.0 package declares OFL-1.1) | Locally bundled typeface |
| axe-core / axe-core Playwright | MPL-2.0 | Development accessibility checks |

No API keys, hosted analytics, external fonts, or model API calls are required for playback. Build tools and test libraries do not become a learner-side service.

## Components redistributed with the Study Harness packages

These components are copied or bundled into published files. Each keeps its upstream license; the license text ships
next to the bundled files.

| Component | Version | License | Where it is redistributed | License text shipped |
| --- | --- | --- | --- | --- |
| KaTeX code and stylesheet | 0.19.0 | MIT, Copyright (c) 2013-2020 Khan Academy and other contributors | `@experiment-kit/player/activity`: lazy math chunk, `dist/activity/math/katex.min.css` | `dist/activity/math/LICENSE` (the katex package license) |
| KaTeX fonts (`KaTeX_*.woff2`, from the katex 0.19.0 package, unmodified) | 0.19.0 | SIL Open Font License 1.1, Copyright (c) 2009-2010 Design Science, Inc. and (c) 2014-2018 Khan Academy, Reserved Font Names `KaTeX_AMS`, `KaTeX_Caligraphic`, `KaTeX_Fraktur`, `KaTeX_Main`, `KaTeX_Math`, `KaTeX_SansSerif`, `KaTeX_Script`, `KaTeX_Size1`–`KaTeX_Size4`, `KaTeX_Typewriter` (as declared in the fonts' name tables) | `@experiment-kit/player/activity`: `dist/activity/math/fonts/` | `dist/activity/math/fonts/LICENSE` (written by the player build from the fonts' declarations and the full OFL 1.1 text, because the katex package ships no OFL file) |
| Inter variable font (Fontsource packaging `@fontsource-variable/inter`) | 5.3.0 | SIL Open Font License 1.1, Copyright 2016 The Inter Project Authors | `@experiment-kit/player/activity`: `dist/activity/fonts/inter/*.woff2` (used only with `fonts: 'bundled'`) | `dist/activity/fonts/inter/LICENSE` (full OFL 1.1 text) |
| Three.js | 0.186.1 | MIT, Copyright © 2010-2026 three.js authors | `@experiment-kit/player-3d` declares it as a peer dependency and does not bundle it; application builds that include the spatial renderer (the site build and the Tauri reference host) bundle it | the `three` package's `LICENSE` in the consumer's installation; reproduce it with any application bundle that contains Three.js |

`dist/activity/THIRD_PARTY_NOTICES.md` in `@experiment-kit/player` lists the bundled components with their versions,
and the player build fails if a directory of bundled fonts has no license file beside it. The Inter and KaTeX fonts
are redistributed unmodified; under the OFL they may be bundled and redistributed with software but not sold by
themselves, and modified versions may not use a Reserved Font Name.

## Rust crates and desktop tooling (not part of the npm packages)

The Study Harness contract crate (`packages/activity/rust`) and the packaged reference host
(`examples/study-harness-tauri`) use the following direct dependencies. Their exact versions and checksums are in each
`Cargo.lock` and in `examples/study-harness-tauri/package-lock.json`.

The npm packages do not redistribute any of them. The unified source release ships only the crates' Rust sources and
lockfiles, not compiled binaries. The reference host binary is built locally and not distributed. Anyone who
distributes such a binary must reproduce the licenses of everything it links.

| Component | License | Role |
| --- | --- | --- |
| `jsonschema` 0.60.1 | MIT | JSON Schema validation in the contract crate |
| `serde`, `serde_json` | MIT OR Apache-2.0 | JSON handling |
| Tauri (`tauri` 2.12.5, `tauri-build`), `@tauri-apps/api` and `@tauri-apps/cli` 2.12.4 | Apache-2.0 OR MIT | Reference host shell, IPC and build tooling |
| `rusqlite` 0.41.0, `libsqlite3-sys` 0.39.1 | MIT | Reference host storage. The `bundled` feature compiles the SQLite library, which is in the public domain, into the binary. |
| `sha2`, `uuid`, `tempfile` (tests only) | MIT OR Apache-2.0 | Digests, identifiers, test directories |
