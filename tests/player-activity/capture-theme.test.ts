import { describe, expect, it } from 'vitest';
import type { LearnerProjection, UiState } from '../../packages/activity/src/api';
import { HOST_SUSPENDED_MESSAGE, UI_STATUS } from '../../packages/activity/src/describe';
import {
  awaitRenderedProjection, CAPTURE_FRAME_WAIT, CAPTURE_LIMITS, CaptureError, captureRejection, captureSize, companionText,
} from '../../packages/player/src/activity/capture';
import { captureMetadata, composeCaptureSvg, selectCaptureView, viewTextLines } from '../../packages/player/src/activity/capture-renderer';
import { CONTRAST_RULES, contrastRatio, DEFAULT_TOKENS, parseColor, resolveTheme, tokenVariables } from '../../packages/player/src/activity/theme';
import { CONTENTLESS_STATES, presentStatus } from '../../packages/player/src/activity/status';
import { fixtureProjection, UI_STATES } from '../../examples/study-harness-host/projection-lab.fixtures';

const ready = (): LearnerProjection => fixtureProjection('quadratic', 'ready');

/** Animation frames under test control: `tick()` delivers one; aborting the signal cancels a waiting frame. */
function frames() {
  const waiting: (() => void)[] = [];
  let requested = 0;
  return {
    get requested() { return requested; },
    nextFrame: (signal: AbortSignal) => new Promise<void>(resolve => { requested++; waiting.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); }),
    tick: () => { waiting.shift()?.(); },
  };
}
const settle = <T,>(promise: Promise<T>) => promise.then(() => 'resolved', (error: CaptureError) => error.code);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('capture waits for the current frame (A43)', () => {
  it('resolves once the surface shows the projection and is NOT_READY when a mounted surface never does', async () => {
    const clock = frames(), life = new AbortController();
    let shown = 'p-1';
    const waiting = settle(awaitRenderedProjection({ projectionId: 'p-2', shown: () => shown, nextFrame: clock.nextFrame, signal: life.signal }));
    await flush(); clock.tick(); await flush();
    shown = 'p-2';
    clock.tick();
    expect(await waiting).toBe('resolved');
    const stuck = settle(awaitRenderedProjection({ projectionId: 'p-3', shown: () => shown, nextFrame: clock.nextFrame, signal: life.signal }));
    for (let i = 0; i < CAPTURE_FRAME_WAIT; i++) { await flush(); clock.tick(); }
    expect(await stuck).toBe('NOT_READY');
  });

  it('disposal while waiting rejects DISPOSED at once, even when no frame ever comes (hidden page)', async () => {
    const clock = frames(), life = new AbortController();
    const waiting = settle(awaitRenderedProjection({ projectionId: 'p-2', shown: () => 'p-1', nextFrame: clock.nextFrame, signal: life.signal }));
    await flush();
    expect(clock.requested).toBe(1);
    life.abort();
    expect(await waiting).toBe('DISPOSED');
    // Frames that do come after disposal change nothing, and a capture started after disposal never waits.
    const late = new AbortController();
    const delivered = settle(awaitRenderedProjection({ projectionId: 'p-2', shown: () => 'p-1', nextFrame: clock.nextFrame, signal: late.signal }));
    await flush(); clock.tick(); await flush();
    late.abort();
    clock.tick();
    expect(await delivered).toBe('DISPOSED');
    const requested = clock.requested;
    expect(await settle(awaitRenderedProjection({ projectionId: 'p-2', shown: () => 'p-2', nextFrame: clock.nextFrame, signal: life.signal }))).toBe('DISPOSED');
    expect(clock.requested).toBe(requested);
  });
});

describe('capture bounds (report §19, N6)', () => {
  it('clamps the scale and fits both sides and the pixel budget', () => {
    expect(captureSize(640, 480, 2)).toEqual({ width: 1280, height: 960, scale: 2, reduced: false });
    expect(captureSize(640, 480, 100).scale).toBe(CAPTURE_LIMITS.maxScale);
    const tall = captureSize(1000, 9000, 1);
    expect(tall.height).toBeLessThanOrEqual(CAPTURE_LIMITS.maxSide);
    expect(tall.reduced).toBe(true);
    for (const [w, h, s] of [[4000, 4000, 4], [3000, 3000, 2], [5000, 100, 1], [1, 1, 4], [640, 480, -1], [640, 480, Number.NaN]] as const) {
      const size = captureSize(w, h, s);
      expect(size.width).toBeLessThanOrEqual(CAPTURE_LIMITS.maxSide);
      expect(size.height).toBeLessThanOrEqual(CAPTURE_LIMITS.maxSide);
      expect(size.width * size.height).toBeLessThanOrEqual(CAPTURE_LIMITS.maxPixels);
      expect(size.width).toBeGreaterThanOrEqual(1);
    }
    expect(() => captureSize(0, 100)).toThrow(CaptureError);
  });

  it('rejects unresolved previews and running playback, and missing frames', () => {
    expect(captureRejection(ready())).toBeNull();
    const reasons: Partial<Record<UiState, string>> = { 'tentative-preview': 'CAPTURE_REJECTED', playing: 'CAPTURE_REJECTED', empty: 'NOT_READY', preparing: 'NOT_READY', disposed: 'DISPOSED' };
    for (const [state, code] of Object.entries(reasons)) {
      const rejection = captureRejection(fixtureProjection('quadratic', state as UiState));
      expect(rejection?.code).toBe(code);
      expect(rejection?.recovery.length).toBeGreaterThan(0);
    }
    expect(captureRejection(fixtureProjection('quadratic', 'tentative-preview'))?.recovery).toMatch(/Commit or cancel/);
    // A preview identity alone (frame not yet tentative) is still unresolved.
    expect(captureRejection({ ...ready(), preview: { previewId: 'p', parameter: 'eta' } })?.code).toBe('CAPTURE_REJECTED');
  });

  it('selects the named view or the first graphical view, and never an unknown one', () => {
    expect(selectCaptureView(ready()).viewId).toBe('landscape');
    expect(selectCaptureView(ready(), 'trace-plot').viewId).toBe('trace-plot');
    expect(() => selectCaptureView(ready(), 'hidden-solution')).toThrow(/not shown/);
  });

  it('embeds identities only in metadata', () => {
    const metadata = captureMetadata('surface-1', ready(), 'landscape');
    expect(Object.keys(metadata).sort()).toEqual(['activityRevision', 'frameId', 'presentationRevision', 'projectionDigest', 'projectionId', 'surfaceId', 'viewId']);
  });

  it('builds the text/numeric companion from the projection only', () => {
    const projection = ready();
    const text = companionText(projection, selectCaptureView(projection), 'en');
    expect(text).toContain('Step size in gradient descent');
    expect(text).toContain('Position: n = 3 of 1000');
    expect(text).not.toContain(projection.guards.expectedRunId!);
    const values = projection.views.find(view => view.viewId === 'readouts')!;
    expect(companionText(projection, values, 'en')).toContain('- Position x_n: 0.5');
    expect(viewTextLines(projection.views.find(view => view.viewId === 'rules')!)).toContain('Objective: f(x) = (a/2)·x²');
  });

  it('composes pure, escaped SVG with metadata and no foreignObject', () => {
    const projection = ready();
    const { svg, width, height } = composeCaptureSvg({
      metadata: captureMetadata('surface-1', projection, 'landscape'), title: '<script>alert(1)</script> & title', summary: 'Summary "quoted"',
      scene: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="10" height="10"/></svg>', width: 300, height: 200 },
      textLines: ['Objective: f(x) = (a/2)·x² <b>bold</b>'], footer: 'n = 3 of 1000', colors: { background: '#ffffff', text: '#17212b', muted: '#4a5866', border: '#c9d2db' },
      fontFamily: 'system-ui', fontFaces: '',
    });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toMatch(/foreignObject|<script|<b>/);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('<metadata>{&quot;surfaceId&quot;:&quot;surface-1&quot;');
    expect(width).toBeGreaterThanOrEqual(332);
    expect(height).toBeGreaterThan(200);
  });
});

describe('theme tokens (report §10.1: host tokens cannot hide meaningful states)', () => {
  it('ships light and dark palettes that satisfy every contrast rule', () => {
    for (const mode of ['light', 'dark'] as const) {
      const tokens = DEFAULT_TOKENS[mode];
      for (const rule of CONTRAST_RULES) for (const other of rule.against) expect(contrastRatio(tokens[rule.token], tokens[other]), `${mode} ${rule.token}/${other}`).toBeGreaterThanOrEqual(rule.min);
    }
  });

  it('parses only opaque literal colours', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
    for (const bad of ['transparent', 'var(--x)', 'url(x)', 'rgba(0,0,0,0)', '#12345', 'rgb(300,0,0)', 'red']) expect(parseColor(bad)).toBeNull();
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('keeps safe overrides and ignores unsafe ones with reasons', () => {
    const { tokens, rejected } = resolveTheme('light', {
      primary: '#004d99', focus: 'transparent', text: '#eeeeee', error: '#ff9999', fontFamily: 'Inter; } body { display:none', fontSize: '4px', radius: '12px',
      warning: 'var(--host-warning)', ...({ unknown: '#000' } as object),
    });
    expect(tokens.primary).toBe('#004d99');
    expect(tokens.radius).toBe('12px');
    for (const token of ['focus', 'text', 'error', 'fontFamily', 'fontSize', 'warning', 'unknown']) expect(rejected.map(r => r.token)).toContain(token);
    expect(tokens.focus).toBe(DEFAULT_TOKENS.light.focus);
    expect(tokens.text).toBe(DEFAULT_TOKENS.light.text);
    expect(tokens.fontFamily).toBe(DEFAULT_TOKENS.light.fontFamily);
  });

  it('rejects a background that would make the default text or status colours unreadable', () => {
    const { tokens, rejected } = resolveTheme('light', { background: '#222222' });
    expect(tokens.background).toBe('#ffffff');
    expect(rejected[0].token).toBe('background');
    const dark = resolveTheme('dark', { background: '#000000', surface: '#0a0a0a' });
    expect(dark.rejected).toEqual([]);
    expect(dark.tokens.background).toBe('#000000');
  });

  it('exposes tokens as --ema-* custom properties and disables motion under reduced motion', () => {
    const variables = tokenVariables(DEFAULT_TOKENS.light, true);
    expect(variables['--ema-border-strong']).toBe(DEFAULT_TOKENS.light.borderStrong);
    expect(variables['--ema-motion-duration']).toBe('0ms');
    expect(tokenVariables(DEFAULT_TOKENS.light)['--ema-motion-duration']).toBe('140ms');
  });
});

describe('UI states (report §10.4)', () => {
  it('presents every state with learner-safe text and no internal identifiers', () => {
    for (const state of UI_STATES) {
      const projection = fixtureProjection('quadratic', state);
      const status = presentStatus(projection);
      // Routine states say nothing: playback and pauses show in the navigation, a ready card needs no words.
      if (state === 'ready' || state === 'paused' || state === 'playing') { expect(status).toBeNull(); continue; }
      expect(status, state).not.toBeNull();
      const text = `${status!.title} ${status!.message ?? ''}`;
      expect(text).not.toMatch(/fixture-|projection-|run-|sha256|Error:|at \w+ \(/);
      expect(status!.glyph.length).toBeGreaterThan(0);
    }
    expect(presentStatus(fixtureProjection('quadratic', 'tentative-preview'))!).toMatchObject({ actions: ['commit', 'cancel'], placement: 'inline' });
    expect(presentStatus(fixtureProjection('quadratic', 'recoverable-failure'))!).toMatchObject({ actions: ['retry'], placement: 'banner' });
    expect([...CONTENTLESS_STATES].sort()).toEqual(['disposed', 'empty', 'preparing']);
    // A host pause can leave the card visible: it says "Paused by the host" and never claims the card is hidden.
    const suspended = fixtureProjection('quadratic', 'suspended');
    const hostPaused = presentStatus({ ...suspended, status: { ...suspended.status, message: HOST_SUSPENDED_MESSAGE } })!;
    expect([hostPaused.title, hostPaused.message]).toEqual(['Paused by the host', 'It continues at the same step when the host resumes it.']);
    expect(`${hostPaused.title} ${hostPaused.message}`).not.toMatch(/hidden|not visible/);
    // An offscreen, collapsed or hidden card keeps "Paused while hidden".
    const hiddenPaused = presentStatus({ ...suspended, status: { ...suspended.status, message: UI_STATUS.suspended.message } })!;
    expect([hiddenPaused.title, hiddenPaused.message]).toEqual(['Paused while hidden', 'It continues at the same step when it is shown again.']);
  });
});
