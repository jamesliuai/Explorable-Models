# Player design

## Current presentation (0.3, 2026-10-29)

The toolkit now shares one warm-neutral visual language with its first embedding host (Study Harness). The owner's
2026-10-29 direction replaced the earlier white/cool-blue/Inter concept below; that concept is kept as history, and its
scientific corrections and interaction requirements still apply.

- **Surfaces.** Warm charcoal by default in the standalone pages (`#141413` page, `#1a1a19` card, `#212120` raised,
  `#2a2a28` selected) and a warm off-white light palette (`#fbfaf7`, `#f3f2ee`, `#e8e6e0`). Hairline separators
  (`#31312e` dark, `#dedbd3` light) instead of nested bordered boxes; one hairline frame around a drawing. Control
  boundaries keep 3:1 (`borderStrong` `#77746d` / `#8b877e`); text tokens keep 4.5:1 on the surfaces they are used on.
- **Shape and type.** Radii 5/7/10px; no pills, badges as plain small text, no glows or shadows except a modal's. The
  platform UI font for controls, labels, values and diagram text; a book serif (Palatino → Palatino Linotype → Book
  Antiqua → system serif) for teaching prose: activity titles, standalone stage instructions, text descriptions, page
  questions. KaTeX stays the mathematical typesetting and is never shrunk to fit.
- **Colour.** No brand accent. The one primary action is neutral (light on dark, dark on light: `action`/`onAction`).
  Colour is reserved for scientific quantities and comparisons (the mark roles `primary` blue, `secondary` violet,
  `accent` orange, `positive` green, `negative`/`error` red, `warning` amber, `reference` and `muted` neutrals) and for
  meaningful states. Every mark role and state keeps a non-colour cue (dash, marker shape, glyph, rule or label);
  charts are not made monochrome. Pressed toggles use a neutral underline.
- **Status.** Routine saving is not shown (it stays readable by assistive technology); unsaved or failed changes,
  errors, boundaries, undefined values and tentative previews remain visible with glyphs and rules.
- **Embedded and standalone.** The learner card has two presentations (`variant`): `standalone` carries its own title
  and instruction; `embedded` leaves the lesson prompt and composer to the host, shows the drawing, primary parameters
  and essential values first, keeps the title as the accessible heading and gathers secondary tools in one “More tools”
  disclosure. See [embedding](embedding.md#presentation-variants-theme-and-fonts-03).
- **Where it applies.** `@explorable-models/player/activity` tokens and stylesheet, the 3D renderer's controls and
  fallback palette (`@explorable-models/player-3d`), the schema 2.0 surface (`--em-*`), the experiment gallery
  (`gallery.html`), the composition studio and guide, and the example collection (`showcase.html`). Light and system
  themes remain supported everywhere (`?theme=light|system` on the demo pages).

Verification for this presentation pass was bounded by the owner's direction: typecheck, the directly affected unit
tests and a few desktop Chromium screenshots (showcase, gallery, studio, the integration fixture in both variants and
themes, and one 3D surface view). `npm run test:browser`, the cross-browser specs and the full release pipeline were
deferred for this pass; they remain the gates for any release claim.

## Historical concept (superseded for presentation)

The full primary-screen concept is retained outside the source tree at the task's visualization path, `explorable-models-concept.png`. It sets the player composition; the diagrams themselves are semantic SVG and Three.js views computed from model frames.

White background, cool gray diagram surface, navy text, blue primary quantity and teal comparison. Header 64px; navigation rail 228px; content gutter 28px. A two-thirds scene and one-third controls layout collapses to a single column below 1000px. Inter typography; 32px/1.2 heading, 14px body, 12–13px labels. Hairline borders, 5–8px radii, visible blue focus rings, restrained 18px outline icons. (Palette, typeface and focus colour superseded by the current presentation above; the composition and the requirements below still hold.)

Primary copy: Explorable Models; Experiments; Authoring guide; Export; Rolling bodies; Linear transformations; Base rates; Saved runs; Model & checks; Same ramp. Different motion.; Why does a sphere reach the bottom before a hoop?; Save state; Experiment; 2D; 3D; Play; Step; Reset; Set up the experiment; Body type; Ramp angle; Advanced parameters; At this moment; Where the energy goes; Speed over time; Ideal rolling without slipping; View assumptions.

Required scientific corrections to the visual concept: the supported angle is 0–45°, the sphere must travel farther than the hoop at equal time, the speed traces are straight until the terminal event, and rotation is signed and calculated from distance/radius. The initial state is released from rest. Time, numbers, and graph positions therefore intentionally differ from the illustrative mockup.

Saved runs, model/check inspector, authoring guide, export dialog, and nonvisual tables extend the same component system. All controls must perform real operations; no remote fonts or imagery are required for playback.

## Final visual review (historical concept)

The generated concept and the rendered 1536 × 1024 desktop capture were inspected together with `view_image`. Additional Chromium captures covered 390 px mobile layouts, 1024/1440 px browser checks, the exact rolling endpoint, horizontal and steep ramps, extreme body sizes and force vectors, and singular/extreme matrix maps. The built-in browser was used for interactive inspection; the installed Browser plugin was unavailable, so automated flows used the pinned Playwright Chromium runtime.

| Comparison | Concept and rendered evidence | Resolution |
| --- | --- | --- |
| Composition | White header and navigation rail; dominant pale-blue scene; right controls; two linked panels below | Preserved. Desktop scene height fixed at 390 px so the linked panels remain visible. |
| Typography | Navy heading, Inter UI text, quieter labels, blue primary values | Preserved; labels rendered in measured SVG coordinates so mobile text remains 11–12 px instead of shrinking with the entire drawing. |
| Palette and surfaces | White page, cool scene, blue primary body, teal comparison, hairline borders | Preserved; muted copy and teal bars darkened for contrast. |
| Geometry and motion | Concept shows an illustrative ramp with inconsistent angle, ordering, and speed curve | Corrected: isotropic physical axes, sphere ahead at equal time, signed rotation, straight speed traces, exact terminal events. The physically correct 30° ramp occupies less horizontal width than the illustrative concept. |
| Spacing and controls | Scene toolbar, transport row, exact value inputs, right-side setup | Preserved with added working force/comparison toggles and playback-rate control. Focus rings now appear only on interactive elements. |
| Labels and icons | Small outline icons and labelled bodies/axes | Consistent Lucide outline family. Body callouts and matrix labels reposition to prevent collisions; tiny bodies use an explicitly magnified rotation inset. |
| Responsive behavior | Desktop is the primary concept | Mobile stacks the scene, linked views, and controls, with a compact navigation drawer. Matrix and rolling marks remain readable without horizontal overflow. |
| 3D endpoint framing | The mobile 3D camera initially looked toward the origin and could clip the terminal body | Corrected OrbitControls target initialization and fit the default/reset camera to the full ramp and body trajectory at the actual viewport aspect. Reviewed 390 px and 1440 px captures, including the exact endpoint, 0°/45° inclines, and 0.05/0.5 m radii. Explicitly saved camera poses remain unchanged; orbit, reset, and snapshot restoration were verified. |

Above-the-fold copy was compared with the allowed list above. Main title, question, navigation, primary actions, setup, transport, and linked-view headings match. Intentional functional additions are **Forces**, **Compare with hoop**, **More experiments**, and playback speed. **Rotation** is clarified to **Signed rotation**. Angle limits, current values, force scale, terminal messages, and energy totals come from the actual model rather than the illustrative image. These changes preserve the supplied scientific requirements.

The final render was verified against the concept's composition, typography, palette, icon treatment, and interaction hierarchy. No material clipping, label collisions, or unintended layout mismatches remained in the reviewed states. Functional evidence includes play/step/reset, exact input, keyboard/drag manipulation, linked values, save/restore, model checks, and portable export.
