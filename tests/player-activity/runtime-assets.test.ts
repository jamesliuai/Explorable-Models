import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ActivityBinding, CommandOutcome, LearnerProjection } from '../../packages/activity/src/api';
import { assetLocations, fontFaceCss, fontsForText, INTER_FONT_FILES, parseFontFaces, stripFontFaces, unicodeRangeIncludes } from '../../packages/player/src/activity/assets';
import { KATEX_FONT_FILES } from '../../packages/player/src/activity/math-font-urls';
import { createAnnouncer, createOperationId, createSurfaceId, PreviewGesture } from '../../packages/player/src/activity/runtime';
import { fixtureProjection } from '../../examples/study-harness-host/projection-lab.fixtures';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

describe('identifiers', () => {
  it('match the contract ID pattern and are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createSurfaceId()));
    expect(ids.size).toBe(200);
    for (const id of [...ids, createOperationId()]) expect(id).toMatch(ID_PATTERN);
  });
});

describe('announcements (report §11: committed changes, boundaries and errors at a controlled rate)', () => {
  const harness = () => {
    let time = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const spoken: string[] = [];
    const announcer = createAnnouncer({ emit: text => spoken.push(text), minIntervalMs: 1000, now: () => time, setTimer: (fn, ms) => { const timer = { at: time + ms, fn }; timers.push(timer); return timer; }, clearTimer: handle => { timers.splice(timers.indexOf(handle as typeof timers[number]), 1); } });
    const advance = (ms: number) => { time += ms; for (const timer of [...timers].filter(t => t.at <= time)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } };
    return { announcer, spoken, advance };
  };

  it('speaks at most once per interval, keeping the most important pending message', () => {
    const { announcer, spoken, advance } = harness();
    announcer.announce('Updated: n = 1.', 'committed');
    announcer.announce('Updated: n = 2.', 'committed');
    announcer.announce('Boundary case.', 'boundary');
    announcer.announce('Updated: n = 3.', 'committed');
    expect(spoken).toEqual(['Updated: n = 1.']);
    advance(1000);
    expect(spoken).toEqual(['Updated: n = 1.', 'Boundary case.']);
    advance(5000);
    expect(spoken).toHaveLength(2);
  });

  it('answers learner requests immediately, skips repeats and stops after dispose', () => {
    const { announcer, spoken, advance } = harness();
    announcer.announce('Updated.', 'committed');
    announcer.announce('Error: not applied.', 'error');
    announcer.announce('Current values: x = 0.5.', 'request');
    expect(spoken).toEqual(['Updated.', 'Current values: x = 0.5.']);
    advance(2000);
    expect(spoken).toHaveLength(2);
    announcer.announce('Current values: x = 0.5.', 'committed');
    expect(spoken).toHaveLength(2);
    announcer.dispose();
    announcer.announce('After dispose', 'request');
    expect(spoken).toHaveLength(2);
  });
});

/** Fake binding that records gesture commands; preview support is switchable. */
function recordingBinding(previewAllowed: boolean) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let projection: LearnerProjection = fixtureProjection('quadratic', 'ready');
  const ok = (): CommandOutcome => ({ ok: true, projection });
  const binding = {
    getProjection: () => projection,
    beginPreview(input: Record<string, unknown>) {
      calls.push({ name: 'beginPreview', input });
      if (!previewAllowed) return { ok: false, diagnostics: [{ code: 'POLICY_DENIED', path: '$', message: 'Previews are not allowed in this stage.' }] };
      projection = { ...projection, preview: { previewId: 'pv-1', parameter: String(input.parameter) } };
      return ok();
    },
    updatePreview(input: Record<string, unknown>) { calls.push({ name: 'updatePreview', input }); return ok(); },
    async commitPreview(input: Record<string, unknown>) { calls.push({ name: 'commitPreview', input }); projection = { ...projection, preview: null }; return ok(); },
    cancelPreview(input: Record<string, unknown>) { calls.push({ name: 'cancelPreview', input }); projection = { ...projection, preview: null }; return ok(); },
    async commitParameters(input: Record<string, unknown>) { calls.push({ name: 'commitParameters', input }); return ok(); },
  } as unknown as ActivityBinding;
  return { binding, calls, end: () => { projection = { ...projection, preview: null }; } };
}

describe('preview gestures (report §9, A39–A40)', () => {
  const hooks = (failures: string[] = [], disposed = () => false) => ({ onFailure: (d: { message: string }[]) => failures.push(...d.map(x => x.message)), isDisposed: disposed });

  it('pointer gesture: begin from the committed guards, update tentatively, commit once', async () => {
    const { binding, calls } = recordingBinding(true);
    const gesture = new PreviewGesture(binding, 'eta', hooks());
    gesture.begin('pointer');
    gesture.update(0.3); gesture.update(0.35); gesture.update(0.4);
    await gesture.commit({ eta: 0.25 });
    expect(calls.map(c => c.name)).toEqual(['beginPreview', 'updatePreview', 'updatePreview', 'updatePreview', 'commitPreview']);
    expect(calls[0].input).toMatchObject({ gesture: 'pointer', parameter: 'eta', expectedScientificVersion: 12, expectedRunId: 'fixture-run' });
    expect(calls[3].input).toMatchObject({ previewId: 'pv-1', displayValues: { eta: 0.4 } });
    expect(calls[4].input).toMatchObject({ previewId: 'pv-1', expectedScientificVersion: 12 });
    expect(new Set(calls.map(c => c.input.operationId)).size).toBe(calls.length);
    expect(gesture.active).toBe(false);
  });

  it('cancel keeps the reason and never commits', () => {
    for (const reason of ['escape', 'pointercancel', 'blur'] as const) {
      const { binding, calls } = recordingBinding(true);
      const gesture = new PreviewGesture(binding, 'eta', hooks());
      gesture.begin('keyboard'); gesture.update(0.3); gesture.cancel(reason);
      expect(calls.map(c => c.name)).toEqual(['beginPreview', 'updatePreview', 'cancelPreview']);
      expect(calls[2].input).toMatchObject({ previewId: 'pv-1', reason });
    }
  });

  it('without an authorized preview the gesture is a local draft committed once, and only if changed', async () => {
    const { binding, calls } = recordingBinding(false);
    const gesture = new PreviewGesture(binding, 'eta', hooks());
    gesture.begin('pointer');
    expect(gesture.state).toBe('draft');
    gesture.update(0.5); gesture.update(0.75);
    await gesture.commit({ eta: 0.25 });
    expect(calls.map(c => c.name)).toEqual(['beginPreview', 'commitParameters']);
    // The draft keeps its own provenance: a pointer gesture is never recorded as exact entry.
    expect(calls[1].input).toMatchObject({ displayValues: { eta: 0.75 }, expectedScientificVersion: 12, gesture: 'pointer' });
    const unchanged = recordingBinding(false);
    const again = new PreviewGesture(unchanged.binding, 'eta', hooks());
    again.begin('keyboard'); again.update(0.25); await again.commit({ eta: 0.25 });
    expect(unchanged.calls.map(c => c.name)).toEqual(['beginPreview']);
  });

  it('a preview ended elsewhere ends the gesture: release commits nothing (G24); a disposed surface sends nothing', async () => {
    const { binding, calls, end } = recordingBinding(true);
    const gesture = new PreviewGesture(binding, 'eta', hooks());
    gesture.begin('drag');
    end();
    (binding as unknown as { updatePreview: () => CommandOutcome }).updatePreview = () => { calls.push({ name: 'updatePreview', input: {} }); return { ok: false, diagnostics: [{ code: 'NOT_FOUND', path: '$', message: 'No preview.' }] }; };
    gesture.update({ eta: 0.6 });
    // Before G24 the gesture continued as a draft and committed the dragged value with gesture 'exact'.
    expect(gesture.state).toBe('ended');
    gesture.update({ eta: 0.8 });
    expect(await gesture.commit({ eta: 0.25 })).toBeNull();
    expect(calls.map(c => c.name)).toEqual(['beginPreview', 'updatePreview']);
    expect(gesture.active).toBe(false);
    let disposed = false;
    const late = recordingBinding(true);
    const lateGesture = new PreviewGesture(late.binding, 'eta', hooks([], () => disposed));
    lateGesture.begin('pointer');
    disposed = true;
    lateGesture.update(1); await lateGesture.commit({ eta: 0.25 }); lateGesture.cancel('blur');
    expect(late.calls.map(c => c.name)).toEqual(['beginPreview']);
  });
});

describe('local assets (native.md N3–N5)', () => {
  it('mirrors the KaTeX 0.19 @font-face rules exactly (woff2 only)', async () => {
    const css = await readFile(new URL('../../node_modules/katex/dist/katex.min.css', import.meta.url), 'utf8');
    const rules = parseFontFaces(css).map(rule => `${rule.family}|${rule.style}|${rule.weight}|${rule.src.replace('fonts/', '')}`).sort();
    const table = KATEX_FONT_FILES.map(font => `${font.family}|${font.style}|${font.weight}|${font.path.replace('math/fonts/', '')}`).sort();
    expect(table).toEqual(rules);
    expect(stripFontFaces(css)).not.toMatch(/@font-face|url\(/);
  });

  it('mirrors the selected Inter subsets and their unicode ranges', async () => {
    const css = await readFile(new URL('../../node_modules/@fontsource-variable/inter/wght.css', import.meta.url), 'utf8');
    const rules = parseFontFaces(css);
    for (const font of INTER_FONT_FILES) {
      const rule = rules.find(candidate => candidate.src.endsWith(font.path.replace('fonts/inter/', '')));
      expect(rule, font.path).toBeDefined();
      expect(rule!.unicodeRange).toBe(font.unicodeRange);
      expect(rule!.weight).toBe(font.weight);
    }
  });

  it('matches unicode ranges and picks only the subsets a text needs', () => {
    expect(unicodeRangeIncludes('U+0000-00FF,U+0131', 0x41)).toBe(true);
    expect(unicodeRangeIncludes('U+0000-00FF,U+0131', 0x0131)).toBe(true);
    expect(unicodeRangeIncludes('U+0000-00FF,U+0131', 0x03b7)).toBe(false);
    expect(unicodeRangeIncludes('U+04??', 0x04ff)).toBe(true);
    expect(unicodeRangeIncludes(null, 0x1f600)).toBe(true);
    expect(fontsForText(INTER_FONT_FILES, 'Step size').map(font => font.path)).toEqual(['fonts/inter/inter-latin-wght-normal.woff2']);
    expect(fontsForText(INTER_FONT_FILES, 'Step size η').length).toBe(2);
  });

  it('serializes font faces with quoted absolute sources and resolves a relocated asset base', () => {
    const css = fontFaceCss([KATEX_FONT_FILES[0]], () => 'https://app.example/assets/a"b.woff2');
    expect(css).toBe('@font-face{font-family:"KaTeX_AMS";font-style:normal;font-weight:400;font-display:block;src:url("https://app.example/assets/ab.woff2") format("woff2")}');
    const relocated = assetLocations('https://app.example/vendor/activity');
    expect(relocated.katexCss.href).toBe('https://app.example/vendor/activity/math/katex.min.css');
    expect(relocated.fontUrl(INTER_FONT_FILES[0]).href).toBe('https://app.example/vendor/activity/fonts/inter/inter-greek-wght-normal.woff2');
    expect(relocated.stylesheet?.href).toBe('https://app.example/vendor/activity/activity.css');
    expect(assetLocations().katexCss.href).toMatch(/node_modules\/katex\/dist\/katex\.min\.css$/);
  });
});
