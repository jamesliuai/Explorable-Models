# Third-party notices

Experiment Kit's original code and examples are MIT licensed. Scientific source references are linked from model cards; no textbook illustrations, restricted lesson text, or competitor source code is incorporated.

The exact dependency graph and integrity records are in `package-lock.json`. The release packages preserve upstream licenses. Direct dependencies include:

| Package | License | Role |
| --- | --- | --- |
| React, React DOM | MIT | Player interface |
| Vite, esbuild, TypeScript, tsx | MIT | Fixed authoring/build tooling |
| Three.js | MIT | Bounded 3D rendering |
| D3 scale, D3 shape | ISC | SVG plots |
| KaTeX | MIT | Visual mathematics and MathML |
| Lucide React | ISC | Interface icons |
| fflate | MIT | ZIP exports |
| Zod | MIT | MCP argument schemas |
| Model Context Protocol TypeScript SDK | MIT | Local stdio agent adapter |
| Playwright | Apache-2.0 | Browser execution and capture |
| Vitest | MIT | Automated tests |
| Inter / Fontsource variable Inter | SIL Open Font License 1.1 / MIT packaging | Locally bundled typeface |
| axe-core / axe-core Playwright | MPL-2.0 | Development accessibility checks |

No API keys, hosted analytics, external fonts, or model API calls are required for playback. Build tools and test libraries do not become a learner-side service.
