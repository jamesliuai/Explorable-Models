/**
 * DOM mounting of the spatial renderer (report §11, §13, A44–A47): the camera toolbar, the focusable 3D viewport
 * (one tab stop), the canvas, a DOM label overlay positioned through CSSOM (no style attributes, no SVG
 * `foreignObject`), learner-visible notes and the context-lost state. It wires browser events to the DOM-free
 * {@link SpatialController}:
 *
 * - keyboard on the focused viewport: ←/→ turn 15° about the vertical axis, ↑/↓ tilt 15°, + / − zoom, Home resets;
 * - pointer drag turns the view (vertical page scrolling stays available on touch); the wheel zooms when the viewport
 *   has focus or with Ctrl (trackpad pinch);
 * - ResizeObserver resizes; IntersectionObserver and page visibility suspend rendering while hidden or offscreen;
 * - WebGL context loss shows a visible state, attempts restoration automatically and offers a retry, while the
 *   surface's 2D projection and table remain usable (`onStatus`).
 *
 * `dispose()` removes every listener and observer, cancels frames and timers, disposes all geometries and materials and
 * removes the DOM it created. The renderer, its canvas and its WebGL context go back to a bounded per-document pool
 * (pool.ts), so the next mount in that document reuses them instead of creating a context; a renderer the pool does not
 * keep (pool full, context lost) is disposed with `renderer.dispose()` and `renderer.forceContextLoss()`.
 * `releaseIdleRenderers()` releases the idle renderers of a document.
 */
import { WebGLRenderer } from 'three';
import { CAMERA_LIMITS, CAMERA_PRESETS, describeOrbit, PRESET_ORDER, type Orbit, type PresetId } from './camera.js';
import { SpatialController, type ControllerOptions, type SchedulerPort, type SpatialInspection } from './controller.js';
import { toWorld, type ViewFrame } from './frame.js';
import { chooseLabelBox, type Box, type Capsule } from './layout.js';
import type { PlannedLabel, SpatialPlan } from './plan.js';
import { RendererPool } from './pool.js';
import { LifecycleRegistry } from './registry.js';
import { adoptSpatialStyles } from './styles.js';
import { readTheme } from './theme.js';
import type { LabelAnchor, SpatialInstance, SpatialMountOptions, SpatialPresentationInput, SpatialStats, SpatialStatus, SpatialView } from './types.js';
import type { Vec3 } from './vec.js';

/** Automatic restore attempts after a context loss, before the view reports `failed` and offers a retry. */
export const RESTORE_ATTEMPTS = Object.freeze([800, 1500, 3000]);

let probe: boolean | null = null;
/**
 * Runtime probe for WebGL 2 (Three.js' WebGL renderer requires it). The probe context is released immediately. A
 * false result makes the surface render the 2D projection and coordinate table instead of mounting.
 */
export function webglAvailable(): boolean {
  if (probe !== null) return probe;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return (probe = false);
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return (probe = false);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return (probe = true);
  } catch {
    return (probe = false);
  }
}

/** Idle renderers per document (a canvas and its context belong to one document). */
const pools = new WeakMap<Document, RendererPool<WebGLRenderer>>();
const poolOf = (doc: Document): RendererPool<WebGLRenderer> => {
  let pool = pools.get(doc);
  if (!pool) { pool = new RendererPool<WebGLRenderer>(); pools.set(doc, pool); }
  return pool;
};
/**
 * Releases the idle renderers kept for reuse in `doc` (default: the current document): each is disposed and its WebGL
 * context released. Returns how many were released. Mounted views are not affected; a later mount creates a renderer
 * again. Hosts call it when no 3D view will be shown for a while (the pool keeps at most `IDLE_RENDERER_LIMIT`).
 */
export function releaseIdleRenderers(doc?: Document): number {
  const target = doc ?? (typeof document === 'undefined' ? undefined : document);
  return target ? pools.get(target)?.clear() ?? 0 : 0;
}

interface Mounted { inspect(): SpatialInspection & { stats: SpatialStats } }
const mounted = new WeakMap<Element, Mounted>();

/**
 * Inspection hook for automated tests and developer tools: world-space and screen positions of the rendered arrows
 * and axis ends, the current camera, labels, notes and resource counts of the renderer mounted in (or at) `element`.
 * It reads presentation only — everything it returns was drawn from the learner projection.
 */
export function inspect(element: Element): (SpatialInspection & { stats: SpatialStats }) | null {
  return mounted.get(element)?.inspect() ?? null;
}

const ANCHOR: Record<LabelAnchor, [number, number]> = { e: [0, 0.5], ne: [0, 1], n: [0.5, 1], nw: [1, 1], w: [1, 0.5], sw: [1, 0], s: [0.5, 0], se: [0, 0], center: [0.5, 0.5] };
const ALTERNATE_ANCHORS: readonly LabelAnchor[] = ['se', 'nw', 'sw', 'ne', 'n', 's', 'e', 'w'];
/** An axis whose drawn length on screen is below this (CSS pixels) is seen end-on: its labels are hidden. */
const END_ON_PX = 24;
/** Clearance (CSS pixels) labels keep from arrowheads and arrow shafts. */
const HEAD_CLEARANCE = 2;
const SHAFT_CLEARANCE = 3;
let sequence = 0;

export function mount(element: HTMLElement, options: SpatialMountOptions): SpatialInstance {
  if (!element || !element.ownerDocument || typeof element.appendChild !== 'function') throw new TypeError('mount requires a browser HTMLElement.');
  if (!options?.view || !Array.isArray(options.view.marks)) throw new TypeError('mount requires a scene3d view.');
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new TypeError('mount requires an element in a browsing context.');
  const id = `em3-${(++sequence).toString(36)}`;
  const lifecycle = new LifecycleRegistry();
  const timers = new Set<number>();
  let disposed = false;
  let view: SpatialView = options.view;
  let presentation: SpatialPresentationInput = options.presentation;
  const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ---- DOM --------------------------------------------------------------------------------------------------------
  const releaseStyles = adoptSpatialStyles(element);
  const root = create('div', 'em3');
  root.setAttribute('data-em3-root', '');
  const toolbar = create('div', 'em3-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '3D view camera');
  const button = (label: string, action: string, options: { pressed?: boolean; aria?: string } = {}) => {
    const node = create('button', 'ema-button em3-button', label);
    node.type = 'button';
    node.setAttribute('data-em3-action', action);
    if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(options.pressed));
    if (options.aria) node.setAttribute('aria-label', options.aria);
    node.tabIndex = -1;
    return node;
  };
  const presetButtons = new Map<PresetId, HTMLButtonElement>(PRESET_ORDER.map(preset => [preset, button(CAMERA_PRESETS[preset].label, `preset:${preset}`, { pressed: false, aria: `${CAMERA_PRESETS[preset].label} view` })]));
  const resetButton = button('Reset view', 'reset', { aria: 'Reset view (3D)' });
  // The accessible name starts with the visible label (WCAG 2.5.3), as for Reset view.
  const wholeBoxButton = button('Whole box', 'whole-box', { aria: 'Whole box (3D)' });
  const perspectiveButton = button('Perspective', 'projection', { pressed: false, aria: 'Perspective projection' });
  const zoomIn = button('+', 'zoom-in', { aria: 'Zoom the 3D view in' });
  const zoomOut = button('−', 'zoom-out', { aria: 'Zoom the 3D view out' });
  const wireframeButton = button('Wireframe', 'wireframe', { pressed: false, aria: 'Wireframe surface' });
  const separator = () => { const node = create('span', 'em3-sep'); node.setAttribute('aria-hidden', 'true'); return node; };
  // View-size controls together (reset, whole box, zoom), then the projection and the surface style.
  toolbar.append(...presetButtons.values(), separator(), resetButton, wholeBoxButton, zoomOut, zoomIn, perspectiveButton, wireframeButton);

  const viewport = create('div', 'em3-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'application');
  viewport.setAttribute('aria-roledescription', '3D view');
  const hint = create('p', 'em3-hint', 'Drag to turn the view. With the view focused: arrow keys turn it by 15°, + and − zoom, Home resets.');
  hint.id = `${id}-hint`;
  viewport.setAttribute('aria-describedby', hint.id);
  const labelsLayer = create('div', 'em3-labels');
  labelsLayer.setAttribute('aria-hidden', 'true');
  const state = create('div', 'em3-state');
  state.hidden = true;
  state.setAttribute('role', 'status');
  const stateTitle = create('p', 'em3-state-title');
  const stateText = create('p', '');
  const retry = button('Try again', 'retry');
  retry.tabIndex = 0;
  retry.hidden = true;
  state.append(stateTitle, stateText, retry);
  const key = create('p', 'em3-key', 'Axes: x red solid line, y green dashed line, z blue dotted line, each with an arrowhead and its name at the positive end. The frame is right-handed: x × y = z.');
  const notes = create('ul', 'em3-notes');
  notes.setAttribute('aria-label', '3D view notes');
  const live = create('div', 'em3-sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  // Layout the renderer depends on, set through CSSOM (also where constructable stylesheets are unavailable).
  viewport.style.position = 'relative';
  viewport.style.overflow = 'hidden';
  labelsLayer.style.position = 'absolute';
  labelsLayer.style.inset = '0';
  labelsLayer.style.pointerEvents = 'none';
  root.append(toolbar, viewport, hint, key, notes, live);
  viewport.append(labelsLayer, state);
  element.append(root);

  // ---- renderer and controller -----------------------------------------------------------------------------------
  const scheduler: SchedulerPort = {
    frame: callback => win.requestAnimationFrame(callback),
    cancelFrame: handle => win.cancelAnimationFrame(handle),
    timer: (callback, ms) => win.setTimeout(callback, ms),
    cancelTimer: handle => win.clearTimeout(handle),
    now: () => win.performance.now(),
  };
  const later = (callback: () => void, ms: number) => {
    const handle = win.setTimeout(() => { timers.delete(handle); if (!disposed) callback(); }, ms);
    timers.add(handle);
    return handle;
  };
  const clearTimers = () => { for (const handle of timers) win.clearTimeout(handle); timers.clear(); };

  let canvas: HTMLCanvasElement;
  let renderer: WebGLRenderer;
  let controller: SpatialController;
  let canvasListeners: (() => void)[] = [];
  let labelNodes: { label: PlannedLabel; node: HTMLElement; width: number; height: number }[] = [];
  let lastAnnounced = '';
  /** False while a controller is being constructed (its first plan arrives before it is assigned). */
  let ready = false;

  /** The surface's own words for its 2D alternative (never a claim of equal values the renderer cannot check). */
  const alternative = (): string => {
    try { return (options.describeAlternative?.() ?? '').replace(/\s+/g, ' ').trim().slice(0, 600); } catch { return ''; }
  };
  let stateMessage: string | null = null;
  const writeStateText = (status: string | null) => {
    if (status === 'context-lost') stateText.textContent = [stateMessage ?? 'Trying to restore the 3D view…', alternative()].filter(Boolean).join(' ');
    if (status === 'failed') stateText.textContent = [stateMessage ?? '', alternative()].filter(Boolean).join(' ');
  };
  const setState = (status: SpatialStatus, message: string | null) => {
    root.setAttribute('data-em3-status', status);
    const lost = status === 'context-lost', failed = status === 'failed';
    state.hidden = !(lost || failed);
    stateMessage = message;
    if (lost) stateTitle.textContent = 'Graphics context lost';
    if (failed) stateTitle.textContent = 'The 3D view could not be restored';
    writeStateText(status);
    retry.hidden = !failed;
    if (!disposed) options.onStatus?.(status, message);
  };

  const updateToolbar = (orbit: Orbit) => {
    for (const [preset, node] of presetButtons) node.setAttribute('aria-pressed', String(orbit.preset === preset));
    perspectiveButton.setAttribute('aria-pressed', String(orbit.projection === 'perspective'));
    zoomIn.setAttribute('aria-disabled', String(orbit.zoom >= CAMERA_LIMITS.maxZoom));
    zoomOut.setAttribute('aria-disabled', String(orbit.zoom <= CAMERA_LIMITS.minZoom));
    viewport.setAttribute('aria-label', `${view.title}: ${describeOrbit(orbit)}`);
  };

  const buildLabels = (plan: SpatialPlan) => {
    labelsLayer.replaceChildren();
    labelNodes = plan.labels.map(label => {
      const node = create('span', 'em3-label', label.text);
      node.setAttribute('data-kind', label.kind);
      if ((label.kind === 'mark' || label.kind === 'segment') && label.markId) {
        node.setAttribute('data-select', label.markId);
        node.setAttribute('data-selected', String(presentation.selection === label.markId));
      }
      node.style.position = 'absolute';
      node.style.left = '0';
      node.style.top = '0';
      labelsLayer.append(node);
      return { label, node, width: 0, height: 0 };
    });
    for (const entry of labelNodes) { entry.width = entry.node.offsetWidth; entry.height = entry.node.offsetHeight; }
  };
  const buildNotes = (plan: SpatialPlan) => {
    notes.replaceChildren(...plan.notes.map(note => {
      const item = create('li', '', note.text);
      item.setAttribute('data-kind', note.kind);
      return item;
    }));
    notes.hidden = plan.notes.length === 0;
  };
  /**
   * Positions every label for the current camera. Labels of an axis seen end-on (its name and ticks would stack at one
   * point) are hidden. Arrow shafts and arrowheads are obstacles (G55): an axis, mark or segment label that would overlap
   * an already placed label, an arrowhead or a shaft tries the other sides of its point at two distances; it never covers
   * an arrowhead (it is hidden instead, the tables list every value). A tick label that would overlap a label or an
   * arrowhead is hidden.
   */
  const placeLabels = (frame: ViewFrame) => {
    const camera = controller.updateCamera();
    const { width, height } = controller.viewportSize;
    const endOn = [0, 1, 2].map(axis => {
      const start: Vec3 = [...frame.axisOrigin], end: Vec3 = [...frame.axisOrigin];
      start[axis] = frame.bounds[axis * 2]!; end[axis] = frame.bounds[axis * 2 + 1]!;
      const [x0, y0] = controller.project(toWorld(frame, start), camera), [x1, y1] = controller.project(toWorld(frame, end), camera);
      return Math.hypot(x1 - x0, y1 - y0) < END_ON_PX;
    });
    const placed: Box[] = [];
    // Arrow shafts and arrowheads on screen: the head is a capsule from its base to its apex, as wide as its base.
    const heads: Capsule[] = [], shafts: Capsule[] = [];
    for (const shape of controller.arrowShapes(camera)) {
      const [tx, ty] = controller.project(shape.arrow.tail, camera), [bx, by] = controller.project(shape.base, camera), [ax, ay] = controller.project(shape.apex, camera);
      heads.push({ from: [bx, by], to: [ax, ay], radius: shape.headRadius + HEAD_CLEARANCE });
      shafts.push({ from: [tx, ty], to: [bx, by], radius: SHAFT_CLEARANCE });
    }
    for (const entry of labelNodes) {
      const { label } = entry;
      const axis = label.kind === 'axis' || label.kind === 'tick' ? Number(label.key.split(':')[1]) : -1;
      const [x, y, depth] = controller.project(toWorld(frame, label.at), camera);
      const boxAt = (anchor: LabelAnchor, offset: readonly [number, number]): Box => {
        const [ax, ay] = ANCHOR[anchor];
        const left = x + offset[0] - ax * entry.width, top = y + offset[1] - ay * entry.height;
        return [left - 2, top - 1, left + entry.width + 2, top + entry.height + 1];
      };
      const candidates: Box[] = [boxAt(label.anchor, label.offset)];
      if (label.kind !== 'tick') {
        const reach = Math.max(6, Math.abs(label.offset[0]), Math.abs(label.offset[1]));
        for (const distance of [reach, 2 * reach]) for (const anchor of ALTERNATE_ANCHORS) {
          const [ax, ay] = ANCHOR[anchor];
          candidates.push(boxAt(anchor, [ax === 0 ? distance : ax === 1 ? -distance : 0, ay === 1 ? -distance : ay === 0 ? distance : 0]));
        }
      }
      // Ticks are not moved: one that would overlap a label or an arrowhead is hidden.
      const box = label.kind === 'tick' ? chooseLabelBox(candidates, placed, heads, []) : chooseLabelBox(candidates, placed, heads, shafts);
      const ticked = label.kind === 'tick' && box !== null && placed.some(other => box[0] < other[2] && other[0] < box[2] && box[1] < other[3] && other[1] < box[3]);
      const offscreen = !box || depth < -1 || depth > 1 || box[2] < 0 || box[0] > width || box[3] < 0 || box[1] > height;
      entry.node.hidden = offscreen || (axis >= 0 && endOn[axis]!) || ticked;
      if (entry.node.hidden || !box) continue;
      placed.push(box);
      entry.node.style.transform = `translate(${Math.round(box[0] + 2)}px, ${Math.round(box[1] + 1)}px)`;
    }
  };

  const pool = poolOf(doc);
  const start = () => {
    ready = false;
    // A renderer released by an earlier view of this document is reused (its canvas and context); otherwise one is created.
    const own = pool.acquire(() => new WebGLRenderer({ canvas: doc.createElement('canvas'), antialias: true, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false })).renderer;
    renderer = own;
    canvas = own.domElement;
    canvas.className = 'em3-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    viewport.prepend(canvas);
    const loseContext = own.getContext().getExtension('WEBGL_lose_context');
    const controllerOptions: ControllerOptions = {
      view, presentation, reducedMotion: options.reducedMotion, theme: readTheme(element), ...(options.limits ? { limits: options.limits } : {}),
      // Disposal hands the renderer back to the pool, which keeps it for the next mount or discards it.
      releaseRenderer: contextLost => { pool.release(own, contextLost); },
      hooks: {
        onCamera: camera => { if (!disposed) options.onCamera(camera); },
        onStatus: setState,
        onPlan: (plan, frame) => { buildLabels(plan); buildNotes(plan); wireframeButton.hidden = !plan.surfaces.length; if (ready) placeLabels(frame); },
        onFrame: current => placeLabels(current.currentFrame),
        onOrbit: (orbit, committed) => {
          updateToolbar(orbit);
          if (committed) {
            const text = describeOrbit(orbit);
            live.textContent = text === lastAnnounced ? `${text} ` : text;
            lastAnnounced = text;
          }
        },
      },
    };
    try {
      controller = new SpatialController(own, scheduler, controllerOptions);
    } catch (error) {
      // Whatever the failed controller built is unreachable: the renderer is not reused.
      pool.discard(own);
      throw error;
    }
    ready = true;
    // The plan hook ran inside the constructor before `controller` was assigned: lay out labels and notes now.
    buildLabels(controller.currentPlan);
    buildNotes(controller.currentPlan);
    wireframeButton.hidden = !controller.hasSurface;
    wireframeButton.setAttribute('aria-pressed', String(controller.wireframeOn));
    updateToolbar(controller.getOrbit());
    // A new controller starts `ready` without reporting it: state it here, so after Try again the overlay hides and the
    // surface learns that the 3D view is back (it would otherwise keep showing `failed`).
    setState(controller.currentStatus, null);
    let attempt = 0;
    const tryRestore = () => {
      if (controller.currentStatus !== 'context-lost') return;
      if (attempt >= RESTORE_ATTEMPTS.length) { controller.markFailed('The graphics context could not be restored automatically.'); return; }
      later(() => {
        if (controller.currentStatus !== 'context-lost') return;
        try { loseContext?.restoreContext(); } catch { /* a context lost for another reason restores on its own, if at all */ }
        attempt++;
        tryRestore();
      }, RESTORE_ATTEMPTS[attempt]!);
    };
    canvasListeners = [
      lifecycle.listen<Event>(canvas, 'webglcontextlost', event => { event.preventDefault(); attempt = 0; controller.contextLostEvent(); tryRestore(); }),
      lifecycle.listen<Event>(canvas, 'webglcontextrestored', () => { clearTimers(); controller.contextRestoredEvent(); }),
    ];
    const rect = viewport.getBoundingClientRect();
    controller.resize(rect.width, rect.height, win.devicePixelRatio);
    controller.setVisible(currentlyVisible());
    controller.requestRender();
  };
  /**
   * Disposes the controller, which hands the renderer back to the pool (listeners on the canvas first, so a forced
   * context loss of a discarded renderer is not handled).
   */
  const stop = () => {
    for (const remove of canvasListeners) remove();
    canvasListeners = [];
    clearTimers();
    controller.dispose();
    canvas.remove();
  };

  // ---- visibility, size, theme --------------------------------------------------------------------------------------
  let intersecting = typeof win.IntersectionObserver !== 'function';
  const currentlyVisible = () => intersecting && doc.visibilityState !== 'hidden';
  if (typeof win.IntersectionObserver === 'function') {
    lifecycle.observe(new win.IntersectionObserver(entries => {
      intersecting = entries[entries.length - 1]!.isIntersecting;
      controller?.setVisible(currentlyVisible());
    })).observe(viewport);
  }
  lifecycle.listen(doc, 'visibilitychange', () => controller?.setVisible(currentlyVisible()));
  if (typeof win.ResizeObserver === 'function') {
    lifecycle.observe(new win.ResizeObserver(entries => {
      const box = entries[entries.length - 1]!.contentRect;
      controller?.resize(box.width, box.height, win.devicePixelRatio);
    })).observe(viewport);
  }
  let themeFrame: number | null = null;
  const refreshTheme = () => {
    if (themeFrame !== null) return;
    themeFrame = win.requestAnimationFrame(() => { themeFrame = null; if (!disposed) controller.setTheme(readTheme(element)); });
  };
  const media = win.matchMedia?.('(prefers-color-scheme: dark)');
  if (media) lifecycle.listen(media, 'change', refreshTheme);
  const themed = element.closest('[data-theme]');
  if (themed && typeof win.MutationObserver === 'function') lifecycle.observe(new win.MutationObserver(refreshTheme)).observe(themed, { attributes: true, attributeFilter: ['data-theme', 'style'] });

  // ---- input ------------------------------------------------------------------------------------------------------
  const step = CAMERA_LIMITS.rotateStep;
  const act = (action: string) => {
    if (action.startsWith('preset:')) controller.preset(action.slice(7) as PresetId);
    else if (action === 'reset') controller.reset();
    else if (action === 'whole-box') controller.wholeBox();
    else if (action === 'projection') controller.setProjection(controller.getOrbit().projection === 'perspective' ? 'orthographic' : 'perspective');
    else if (action === 'zoom-in') controller.zoomBy(CAMERA_LIMITS.zoomStep);
    else if (action === 'zoom-out') controller.zoomBy(1 / CAMERA_LIMITS.zoomStep);
    else if (action === 'wireframe') { controller.setWireframe(!controller.wireframeOn); wireframeButton.setAttribute('aria-pressed', String(controller.wireframeOn)); }
    else if (action === 'retry') {
      // Try again sits in the overlay that hides on success: focus then moves to the 3D view instead of the page.
      const refocus = (viewport.getRootNode() as Document | ShadowRoot).activeElement === retry;
      stop();
      try { start(); } catch { setState('failed', 'The 3D view could not start again.'); }
      if (refocus && retry.hidden) viewport.focus();
    }
  };
  const toolbarButtons = () => [...toolbar.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
  const rove = (target: HTMLButtonElement) => { for (const node of toolbarButtons()) node.tabIndex = node === target ? 0 : -1; };
  rove(presetButtons.get(PRESET_ORDER[0]!)!);
  lifecycle.listen<MouseEvent>(root, 'click', event => {
    const target = (event.target as Element | null)?.closest?.('button[data-em3-action]') as HTMLButtonElement | null;
    if (target && root.contains(target) && target.getAttribute('aria-disabled') !== 'true') { if (toolbar.contains(target)) rove(target); act(target.getAttribute('data-em3-action')!); return; }
    const label = (event.target as Element | null)?.closest?.('[data-select]');
    if (label) { const markId = label.getAttribute('data-select'); options.onSelect(presentation.selection === markId ? null : markId); }
  });
  lifecycle.listen<KeyboardEvent>(toolbar, 'keydown', event => {
    const buttons = toolbarButtons();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = buttons[(next + buttons.length) % buttons.length]!;
    rove(target);
    target.focus();
  });
  lifecycle.listen<KeyboardEvent>(viewport, 'keydown', event => {
    if (event.target !== viewport || event.altKey || event.metaKey || event.ctrlKey) return;
    const handled = ({
      ArrowLeft: () => controller.rotateBy(-step, 0), ArrowRight: () => controller.rotateBy(step, 0),
      ArrowUp: () => controller.rotateBy(0, step), ArrowDown: () => controller.rotateBy(0, -step),
      '+': () => controller.zoomBy(CAMERA_LIMITS.zoomStep), '=': () => controller.zoomBy(CAMERA_LIMITS.zoomStep),
      '-': () => controller.zoomBy(1 / CAMERA_LIMITS.zoomStep), _: () => controller.zoomBy(1 / CAMERA_LIMITS.zoomStep),
      Home: () => controller.reset(),
    } as Record<string, () => void>)[event.key];
    if (!handled) return;
    event.preventDefault();
    handled();
  });
  let drag: { pointerId: number; x: number; y: number } | null = null;
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    viewport.removeAttribute('data-dragging');
    controller.endGesture();
  };
  lifecycle.listen<PointerEvent>(viewport, 'pointerdown', event => {
    if (drag || event.button !== 0 || !event.isPrimary || (event.target as Element).closest?.('[data-select], button')) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    try { viewport.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
    viewport.setAttribute('data-dragging', 'true');
    controller.beginGesture();
  });
  lifecycle.listen<PointerEvent>(viewport, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    if (dx || dy) controller.rotateBy(-dx * CAMERA_LIMITS.dragRate, dy * CAMERA_LIMITS.dragRate);
  });
  lifecycle.listen(viewport, 'pointerup', endDrag);
  lifecycle.listen(viewport, 'pointercancel', endDrag);
  lifecycle.listen(viewport, 'lostpointercapture', endDrag);
  lifecycle.listen<WheelEvent>(viewport, 'wheel', event => {
    const focused = viewport === (viewport.getRootNode() as Document | ShadowRoot).activeElement;
    if (!focused && !event.ctrlKey) return;
    event.preventDefault();
    if (event.deltaY) controller.zoomBy(event.deltaY < 0 ? CAMERA_LIMITS.zoomStep : 1 / CAMERA_LIMITS.zoomStep);
  }, { passive: false });

  try {
    start();
  } catch (error) {
    lifecycle.disposeAll();
    root.remove();
    releaseStyles();
    throw error;
  }

  const stats = (): SpatialStats => {
    const current = controller.stats();
    return { ...current, listeners: lifecycle.listeners, observers: lifecycle.observerCount, pending: current.pending + timers.size + (themeFrame !== null ? 1 : 0) };
  };
  const handle: Mounted = { inspect: () => ({ ...controller.inspect(), stats: stats() }) };
  mounted.set(element, handle);
  mounted.set(root, handle);

  return {
    update(next: SpatialView, nextPresentation?: SpatialPresentationInput) {
      if (disposed) return;
      view = next;
      if (nextPresentation) presentation = nextPresentation;
      controller.update(next, presentation);
      for (const entry of labelNodes) if (entry.node.hasAttribute('data-select')) entry.node.setAttribute('data-selected', String(presentation.selection === entry.label.markId));
      // A shown lost/failed state follows the surface's current wording (what its table lists can change with the view).
      if (!state.hidden) writeStateText(root.getAttribute('data-em3-status'));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (themeFrame !== null) { win.cancelAnimationFrame(themeFrame); themeFrame = null; }
      lifecycle.disposeAll();
      canvasListeners = [];
      clearTimers();
      controller.dispose();
      root.remove();
      releaseStyles();
      if (mounted.get(element) === handle) mounted.delete(element);
      mounted.delete(root);
      labelNodes = [];
    },
    stats,
  };
}
