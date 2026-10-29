/** Shared React runtime for the learner surface: context, headings, roving focus and element measurement. */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import type { ActivityBinding, CommandOutcome } from '@experiment-kit/activity';
import type { AssetLocations } from '../assets.js';
import type { KatexModule } from '../math.js';
import type { AnnouncementKind, GestureLane } from '../runtime.js';
import type { SpatialRendererModule } from '../spatial-contract.js';
import type { SurfaceDiagnostic } from '../types.js';

export type CommandScope = 'science' | 'presentation' | 'other';
export interface SurfaceRuntime {
  binding: ActivityBinding;
  surfaceId: string;
  locale: string | undefined;
  headingLevel: number;
  fonts: 'bundled' | 'system';
  locations: AssetLocations;
  reducedMotion: boolean;
  /** A scientific command is in flight; scientific buttons are inert until it settles (no double submission). */
  busy: boolean;
  /**
   * Synchronous form of `busy` that also counts a gesture completion still committing: handlers check it so two
   * activations in the same task (a double click on two scenarios) start at most one scientific command.
   */
  scienceBusy(): boolean;
  /** A gesture completion (slider or point release) is committing; buttons that start other scientific commands wait. */
  settling: boolean;
  /** The surface's gesture completion lane: a gesture pressed while an earlier one commits waits for it (report §9). */
  lane: GestureLane;
  /**
   * Visible reason when the card's state makes every scientific action unavailable (suspended, stale policy,
   * unsupported, awaiting persistence, disposed), else null. Controls stay present and focusable with
   * `aria-disabled` and this reason; hidden content is absent instead (report §10.2, §11).
   */
  inert: string | null;
  disposed(): boolean;
  opId(): string;
  report(diagnostic: SurfaceDiagnostic): void;
  announce(text: string, kind: AnnouncementKind): void;
  /** Runs one binding command; failures become a diagnostic, a visible explanation and an announcement. */
  run(command: () => CommandOutcome | Promise<CommandOutcome>, scope?: CommandScope): Promise<CommandOutcome | null>;
  /** Shows failures reported outside `run` (preview gestures). */
  fail(diagnostics: { code: string; message: string; path?: string; recovery?: string }[]): void;
  loadMath(): Promise<KatexModule>;
  /** Adopts KaTeX's stylesheet into the root of `node` (and registers fonts when bundled). */
  mathStyles(node: Node): Promise<void>;
  spatialLoader?: () => Promise<SpatialRendererModule>;
  /** Shows tables (and focuses them) after a clipped-indicator “Inspect values”. */
  inspectValues(): void;
  /**
   * Layout stability around content that changes size by itself (an equation typeset when it comes on screen): call
   * `layoutAnchor()` just before the change and `keepAnchor(anchor)` once it is in the DOM (a layout effect, before
   * paint). While the learner is aiming the pointer at the card (it moved, scrolled or pressed within the last second),
   * the element under it is kept at the same place on screen by scrolling its container by the distance it moved, so a
   * click or drag lands where the learner aimed. Null when there is nothing to keep.
   */
  layoutAnchor(): LayoutAnchor | null;
  keepAnchor(anchor: LayoutAnchor | null): void;
}
/** The element under the learner's pointer and its position on screen before a layout change. */
export interface LayoutAnchor { element: Element; top: number }

export const RuntimeContext = createContext<SurfaceRuntime | null>(null);
export function useRuntime(): SurfaceRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Study activity components must be rendered inside StudyActivitySurface.');
  return runtime;
}

/** Heading at a clamped level (2–6), so the card fits into the host's outline. */
export function Heading({ level, children, ...props }: { level: number; children: ReactNode; ref?: Ref<HTMLHeadingElement> } & HTMLAttributes<HTMLHeadingElement>) {
  const clamped = Math.min(6, Math.max(2, Math.round(level)));
  const Tag = `h${clamped}` as 'h2';
  return <Tag {...props}>{children}</Tag>;
}

/**
 * Roving tabindex: one tab stop per group; arrow keys move between items marked with `data-roving`, Home/End jump.
 * Disabled items stay focusable (aria-disabled) so their reasons remain discoverable.
 */
export function useRoving(count: number, orientation: 'horizontal' | 'vertical' | 'both' = 'both') {
  const [active, setActive] = useState(0);
  const current = Math.max(0, Math.min(active, count - 1));
  const onKeyDown = useCallback((event: KeyboardEvent<Element>) => {
    const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const allowed = next === undefined || orientation === 'both' || (orientation === 'horizontal' ? /Left|Right/.test(event.key) : /Up|Down/.test(event.key));
    if ((next === undefined && event.key !== 'Home' && event.key !== 'End') || !allowed) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement | SVGElement>('[data-roving]')];
    if (!items.length) return;
    const index = items.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (next ?? 0) + items.length) % items.length;
    event.preventDefault();
    setActive(target);
    items[target].focus();
  }, [orientation]);
  const itemProps = (index: number) => ({ 'data-roving': '', tabIndex: index === current ? 0 : -1, onFocus: () => setActive(index) });
  return { onKeyDown, itemProps };
}

/** Content-box width of an element (ResizeObserver); `fallback` until measured (and during server rendering). */
export function useElementWidth<T extends Element>(fallback: number): [RefObject<T | null>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<[number, number]>([fallback, 15]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const view = element.ownerDocument.defaultView;
    const measure = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      const font = parseFloat(view?.getComputedStyle(element).fontSize ?? '') || 15;
      setSize(previous => (previous[0] === width || width <= 0) && previous[1] === font ? previous : [width > 0 ? width : previous[0], font]);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size[0], size[1]];
}

let unique = 0;
/** Stable ID that satisfies HTML ID rules inside a shadow root or document (React's useId output is not ASCII-safe). */
export function useStableId(prefix: string): string {
  const [id] = useState(() => `${prefix}-${(++unique).toString(36)}`);
  return id;
}
