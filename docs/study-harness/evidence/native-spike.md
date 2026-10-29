# Native feasibility spike (W12 early) — macOS

Run date: 2026-10-26 (`generatedAt` in `native-spike.json`). Machine-readable evidence: [`native-spike.json`](native-spike.json). Captured PNGs: [`native-spike-captures/`](native-spike-captures/).

**Verdict:** the packaged Tauri 2 app ran our browser architecture offline on this machine. All 23 required checks passed. Nothing blocks the architecture, but three findings constrain the contracts: foreignObject capture taints the canvas, workers get no CSP by default, and KaTeX must be rendered through the DOM API. Scope: one macOS machine. This is not a support claim for other macOS versions, Windows or Linux. No signing, notarization, accessibility or performance-budget claim is made.

Reproduce with `cd examples/study-harness-tauri && npm ci && node scripts/run-spike.mjs --rebuild`. The script builds with `tauri build --bundles app --no-sign` and launches `Contents/MacOS/study-harness-reference` with `SH_SPIKE_OUT` set. It waits up to 60 s (SIGTERM, then SIGKILL) and writes the evidence.

> **Correction (2026-10-26):** the reproduction command above names the runner's location when this record was written. The spike was later archived: its runner is now `examples/study-harness-tauri/spike/scripts/run-spike.mjs`, it targets the spike's own `src-tauri` layout and no longer runs against the reference host (see `examples/study-harness-tauri/spike/README.md`). The `generator` field of `native-spike.json` names the same earlier path; the runner's source now records the archived path. The results of this record are unchanged. Current packaged evidence is [`native-conformance.md`](native-conformance.md).

## Environment and identity

| Item | Value |
| --- | --- |
| OS / hardware | macOS 26.6.2 (25G83), Darwin 25.6.0, Mac15,13, Apple M3, 8 logical CPUs, 16 GiB, arm64 |
| WebView | WKWebView, WebKit 21624.5.1.11.3 (`tauri::webview_version`, matches system Safari 26.6.2 bundle version). The UA token is frozen at `AppleWebKit/605.1.15` and carries no Safari version |
| Toolchain | rustc/cargo 1.95.0, Xcode 26.4.1 (17E202), Node 22.22.3, npm 10.9.8 |
| Crates (Cargo.lock) | tauri 2.12.5, tauri-build 2.7.4, tauri-codegen/macros 2.7.4, tauri-runtime 2.12.2, tauri-runtime-wry 2.12.3, tauri-utils 2.10.2, wry 0.57.1, tao 0.37.2, objc2-web-kit 0.3.2, serde 1.0.229, serde_json 1.0.154 |
| npm (exact pins) | @tauri-apps/cli 2.12.4, @tauri-apps/api 2.12.4, vite 8.3.5, typescript 5.9.3, katex 0.19.0 |
| Binary | `StudyHarnessReference.app/Contents/MacOS/study-harness-reference`, sha256 `e499fc96d25c1dda31a4282c758831ac13b8cdfa582c69232f4281b6a7db125c`, 9,715,504 bytes |
| Signature | Linker ad-hoc signature only (`flags=0x20002(adhoc,linker-signed)`). The bundle is unsealed, so `codesign --verify --strict` fails with "code has no resources". It runs locally. Distribution would need owner-controlled signing |
| Origin | `tauri://localhost` (custom protocol, embedded `frontendDist`, no `devUrl`), `isSecureContext: true` |

## Probe results (final run)

| Area | Result |
| --- | --- |
| Module worker | **pass.** `new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' })` loads `tauri://localhost/assets/probe-worker-<hash>.js`. The worker is same-origin and a secure context. `import()` of a split chunk inside the worker works, as do `fetch` of bundled JSON, `crypto.subtle.digest` and `crypto.randomUUID`, and OffscreenCanvas 2D `convertToBlob` |
| blob: worker | **blocked** by `worker-src 'self'`, as intended. It is not needed |
| Web Crypto (page) | **pass.** SHA-256 known answer, v4 UUID, `getRandomValues` |
| Local font | **pass.** A bundled woff2 under its own `@font-face` loaded offline, and its measured width differs from the fallback. Vite deduplicated the copied file with KaTeX's identical `KaTeX_Main-Regular.woff2` asset |
| KaTeX (`katex.render`, `trust:false`, `maxExpand:1000`, `maxSize:20`, `htmlAndMathml`) | **pass.** HTML and MathML render, strut and base heights are non-zero, the KaTeX_Main and KaTeX_Math italic faces load, and `\href` under `trust:false` produces no anchor. No CSP violations |
| KaTeX `renderToString` + `innerHTML` | **blocked.** All 28 inline `style` attributes are dropped (`style-src-attr`), so the layout collapses |
| SVG render | **pass.** Built with `createElementNS` and presentation attributes |
| SVG → PNG (blob: URL → `<img>` → canvas → `toDataURL`) | **pass, not tainted.** Fonts embedded as `data:` inside the SVG change the raster. Page web fonts are not visible inside SVG-as-image |
| SVG with `<foreignObject>` (plain HTML or KaTeX HTML) | **fail: canvas tainted** (`SecurityError: The operation is insecure` on `toDataURL`) |
| KaTeX canvas repaint (DOM walk) | **pass, not tainted.** 13 glyph runs, 1 rule and 1 SVG radical were repainted. Visually checked: `native-spike-captures/png-capture-katex-canvas.png` |
| data: image | **blocked** by `img-src`, as intended |
| WebGL (optional) | WebGL2 available ("Apple GPU", `MAX_TEXTURE_SIZE` 16384), and clear/readPixels works. `webgl2` also works on OffscreenCanvas in the worker |
| eval / `new Function` | **blocked** on the page (`script-src`) and, after the mitigation below, in the worker |
| Remote origins | No remote origin is referenced or fetched by the app. The only remote-URL request is the deliberate negative probe to `https://remote.invalid/…` (reserved name), and `connect-src` blocked it before any network activity. The static `dist/` scan found only XML namespace URIs, the `.invalid` fixtures and an allowlist string. The app process opened **no sockets** (13 `lsof` samples, no LISTEN), so there is no local HTTP server |
| Command ACL | `spike_forbidden` (registered in `invoke_handler`, not in the app manifest grant) → `Command spike_forbidden not allowed by ACL`. The native "executed" flag stayed `false`. `plugin:app|version` was also rejected, because no core permissions are granted |
| Report validation (Rust) | Unknown key rejected by serde `deny_unknown_fields`. A 5,000-character summary was rejected by `validate()`. The valid report was written to the app data dir and `SH_SPIKE_OUT`, and the two copies are identical by sha256. The app exited 0 in about 2 s |

## Effective CSP

Configured (`app.security.csp`):

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' ipc:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
```

Effective header on `index.html`: the same directives, with two differences. Tauri appended four `'sha256-…'` sources to `script-src`, one per bundled `.js` file in `frontendDist` (verified against the files), so they change with every frontend build. Directive order also comes from a hash map and differed between runs of the same binary. Compare policies by normalized directive sets, not by string. `freezePrototype: true` worked with the Vite/KaTeX bundle.

Worker scripts: Tauri attaches CSP only to HTML responses. In the first run the module worker executed `new Function`, meaning it had no policy. The host now creates the window in Rust with `on_web_resource_request`, which adds `default-src 'none'; script-src 'self'; connect-src 'self'` to bundled JavaScript responses. WebKit applies it to the worker: eval is blocked, while `import()` and `fetch` still work.

## Implications for the contracts

1. **Worker URL pattern:** keep `new Worker(new URL('./x', import.meta.url), { type: 'module' })` with `worker.format: 'es'`. It works from `tauri://localhost`, including nested `import()`. Do not allow `blob:` in `worker-src`, and do not use blob/inline workers.
2. **Worker CSP is a host responsibility:** the reference host must add a CSP to worker script responses (or an equivalent mechanism). Otherwise worker code runs without any script restriction. Configuring windows in Rust is therefore part of the host skeleton.
3. **CSP minimum on macOS:** the policy above. `ipc:` in `connect-src` is needed for Tauri's custom-protocol IPC. In the first run without it, `invoke` still worked through the postMessage fallback but raised a `connect-src ipc://localhost/…` violation. `http://ipc.localhost` was not needed on macOS; add it only after Windows verification. No `'unsafe-inline'`, `'unsafe-eval'`, `data:` or remote origins are needed. Build with `assetsInlineLimit: 0`, because Vite otherwise inlines small assets as `data:`, which `font-src`/`img-src 'self'` would block. According to the tauri 2.12.5 / tauri-utils 2.10.2 source (not exercised here), adding an inline `<style>` to the HTML makes Tauri add a nonce to `style-src`, which would also disable any `'unsafe-inline'`.
4. **Styling rule:** under `style-src 'self'`, set styles only through CSSOM (`el.style.x = …`, React `style` props) and SVG presentation attributes. Parsed `style="…"` and `setAttribute('style', …)` are blocked. Math must use `katex.render` (or equivalent DOM construction), never `renderToString` + `innerHTML` or `dangerouslySetInnerHTML`. KaTeX itself uses `setAttribute('style')` for error rendering (`throwOnError:false`), `\fcolorbox` MathML borders and `\pmb` MathML shadows, so those lose styling. Prefer `throwOnError:true` with host-rendered error UI.
5. **PNG capture approach:** do not base capture on `<foreignObject>`; WKWebView taints the canvas. Use serialized pure SVG (fonts embedded as `data:` inside the SVG document) → blob: image → canvas. Repaint math from the laid-out KaTeX DOM onto the canvas (glyph runs with the already-loaded page fonts, border rules, inline SVG radicals). The repaint is a working prototype, not yet a general renderer: it needs fixtures for stretchy delimiters, accents, colors and arrays. `img-src blob:` is required. OffscreenCanvas `convertToBlob` is available in workers if encoding moves off the main thread. Full-window/native snapshots remain a separate host operation and were not tested.
6. **WebGL:** available (WebGL2, including in worker OffscreenCanvas), so the optional 3D package is feasible here. Still probe at runtime and keep the 2D alternative.
7. **Native command boundary:** `AppManifest::commands` plus a capability granting only `allow-spike-report` rejects every other registered command at the IPC layer. Two gaps found:
   - Tauri deserializes the whole IPC payload before the command body runs. Its automatic error lists every expected field name, which leaks schema details through errors. Production commands should take a raw body (`tauri::ipc::Request`, `InvokeBody::Raw`), check the byte length before parsing, and map failures to stable error codes.
   - The spike carried PNGs as base64 in JSON (≤128 KiB each, re-hashed by the launcher). Real capture artifacts should use raw binary IPC.
8. **Auditing:** Resource Timing reports **zero** entries for custom-scheme loads in WKWebView, so it cannot be used to prove offline behavior. Use CSP violation events, an app-level request log, a static bundle scan and process socket sampling instead.
9. **Test-only control:** `SH_SPIKE_OUT`, the auto-exit after the report, the 45 s watchdog and `spike_forbidden` are spike scaffolding. Remove or gate them before this grows into the release reference host.

## Iteration log and limits

- Run 1 (window from config, `connect-src 'self'`, no worker hook): 20/21 required checks. `katex-dom` failed because of a **probe bug**: KaTeX 0.19 renamed `.strut` to `.katex-strut`, and the probe queried the old class. The same run showed the worker CSP gap and the IPC postMessage fallback. Run 2 fixed the selector, added `ipc:`, the worker CSP hook and the canvas-repaint probe, and all required checks passed. The final run (`--rebuild`) produced the evidence above.
- Not tested: Windows/Linux, other macOS versions, signed or notarized builds, WebDriver automation, hidden-window throttling, suspend/restore, multi-window, persistence/restart sequences, accessibility, performance budgets (only a single rAF sample of about 61 fps).
- Repository notes for the owner (no files outside this package were changed):
  - The root `tsconfig.json` includes `examples/`, so this package's `src/` is type-checked by the root `npm run typecheck`. That passes with and without this package's `node_modules`, because `src/native-bridge.ts` shields the `@tauri-apps/api` import. Consider excluding `examples/study-harness-tauri` once the host grows.
  - `scripts/package-release.mjs` copies `examples/` but skips only `node_modules`/`dist`. With a local build present it would pick up about 22 generated `.json`/`.js` files from `src-tauri/target` (about 2 GB locally) and `src-tauri/gen`. Consider adding `target` and `gen` to its skip list.
