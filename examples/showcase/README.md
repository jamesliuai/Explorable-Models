# Interactive conversation cards

Run `npm run dev` and open `/showcase.html`. These six examples share the toolkit's browser-worker document runtime and a custom React/SVG presentation layer. They are complete local examples, not a new public rendering API or a chat service.

| URL query | Example | Try |
| --- | --- | --- |
| `?example=projectile` | Projectile motion | Scrub time, replay, change launch height, reach exact impact |
| `?example=forces` | Block on a slope | Increase friction until the block holds; double mass |
| `?example=waves` | Wave interference | Cancel equal waves, then reduce one amplitude |
| `?example=light` | Refraction | Switch to total reflection and vary the incident angle |
| `?example=matrix` | Linear maps | Shear without changing area, reverse orientation, collapse |
| `?example=probability` | Fault detection | Compare rare and common faults at the same detection rate |

All cards have native sliders, exact numeric inputs, reset and named scenarios. Release a slider to commit, or press Escape during a gesture to cancel. Arrow/Home/End keys commit on key release. Projectile playback opens paused at 28% of the flight, uses the exact analytical impact time, and restarts at time zero after a parameter commit. The timeline uses a normalized fraction so the native range input cannot round the endpoint short of impact.

## Model and presentation

`models.ts` contains data-only schema 2.0 documents. Expressions, trajectories and transformed coordinates are evaluated in browser workers. The React scenes read a single committed frame, then map those quantities into SVG coordinates. No authored model code executes in CLI Node.

- **Projectile:** constant gravity 9.81 m/s², no drag, flat ground, analytical positive flight-time root. Position axes have equal scales. The velocity arrow uses a separate fixed illustrative scale; the impact frame shows velocity immediately before collision.
- **Forces:** gravity, normal and friction vectors share one length scale. Static friction is the smaller of the downhill pull and μN. The same μ is used for the kinetic regime. This is an instantaneous force-balance model, not a time simulation of sliding.
- **Waves:** equal wavelength/frequency sinusoids and their pointwise sum. The two panels have explicitly labeled, different vertical scales. Relative amplitude is undefined when both inputs are zero.
- **Light:** Snell's law at a planar interface. A transmitted sine above one yields explicit undefined angle/direction quantities; the UI omits that ray and explains total internal reflection. Ray appearance does not represent intensity.
- **Matrix:** the family `[[stretch, shear], [0, vertical]]`, using column vectors. Grid endpoints, basis vectors and the transformed square are model quantities. Area is the absolute determinant. The view uses equal scales and clips the grid.
- **Probability:** expected frequencies among 1,000 parts. Fractional cell fills preserve fractional expected counts. The conditional bar magnifies the flagged population. No flags means undefined conditional probability, not zero.

Each card uses the supported document interaction controller, `createDocumentInteractionController` from `@experiment-kit/core/declarative`. It keeps the primary session's gesture tentative while a separate scratch session (created on the first preview) evaluates identified tentative frames for live display. The core preview coordinator keeps at most one scratch evaluation in flight plus the newest pending value, preview epochs reject late results after cancellation or commit, and the last accepted primary state is retained on failure. The scratch session retains only one run. Export during a primary preview remains blocked. Playback and time seeking use the primary session's guarded commands; time seeking preserves the run, while parameter commits restart it. A hidden page suspends the card (playback paused, scratch worker terminated) and it resumes paused without catch-up. Several cards can share one bounded `WorkerBudget` through the controller's `budget` option. The hinged-rod card uses the same controller.

To embed a card in another React host, create a controller for a document in a browser client, pass the corresponding catalog entry and controller to `ExampleCard`, include `style.css`, and dispose the controller when the card unmounts. The surrounding navigation and conversation in `main.tsx` are example host UI. Production persistence, account integration, chat transport, and automatic choice of example remain host responsibilities. These bespoke scenes do not extend the generic player mark vocabulary.

## Verification and captures

`tests/browser/showcase.spec.ts` checks all six models against separately derived engineering fixtures in `tests/reference/fixtures/showcase.json`, verifies tentative interaction and cancellation, exact impact, force-vector addition, collapsed geometry, undefined states, exact-input validation and responsive overflow. It captures desktop/default/boundary/mobile views for visual inspection. The fixtures are independent of candidate expression execution; they are not independent human scientific review.

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
npm run preview -- --port 4173
# In another terminal:
node scripts/capture-showcase.mjs
# To also refresh the three checked-in README images and their metadata:
node scripts/capture-showcase.mjs --readme
```

The capture script uses the installed Playwright Chromium at a 1440-pixel desktop viewport and device scale factor 3. It saves native-resolution PNGs, full conversations and cropped cards, plus contrasting scenario cards, capture metadata, and a local review index under `local-captures/showcase/`. That directory is Git-ignored. The `--readme` option also copies the projectile, matrix and probability cards to `docs/images/showcase/` and writes their capture metadata; inspect those images and the rendered README before committing. Set `SHOWCASE_URL` to capture a different local server. The script requires that Chromium has been installed with `npx playwright install chromium`.

The cards use a restrained conversation shell, a white card with the diagram first, a pale control panel, labeled colors, and a compact metric strip. Mobile stacks controls beneath the diagram. Screenshots are produced from the running implementation without image reconstruction or upscaling.
