/**
 * The learner card before an activity binding exists (report §10.4 `preparing` and `empty`): a host shows it while it
 * prepares or restores an activity, or where no activity is open, so the card frame, title, theme and status look the
 * same as the surface that replaces it. It renders no projection content and calls nothing; the status text comes from
 * the activity runtime's own vocabulary (`UI_STATUS`), so a placeholder never says something the runtime would not.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { UI_STATUS } from '@explorable-models/activity';
import { assetLocations, INTER_FONT_FILES, registerFonts } from './assets.js';
import { presentStatus } from './status.js';
import { adoptActivityStyles } from './styles.js';
import { BUNDLED_FONT_STACK, resolveTheme, tokenVariables, type ThemeMode } from './theme.js';
import type { StudyActivitySurfaceProps } from './types.js';
import { Heading, useStableId } from './components/context.js';

export interface StudyActivityPlaceholderProps extends Pick<StudyActivitySurfaceProps, 'theme' | 'tokens' | 'headingLevel' | 'locale' | 'fonts' | 'assetBase'> {
  /** `preparing` while the host prepares or restores an activity; `empty` where no activity is open. */
  state: 'preparing' | 'empty';
  /** Card title (for example the activity title the host is opening); a neutral title when omitted. */
  title?: string;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

const TITLE: Record<StudyActivityPlaceholderProps['state'], string> = { preparing: 'Activity', empty: 'Activity' };

/** React entry: the card frame in the `preparing` or `empty` state (same classes, tokens and status vocabulary as the surface). */
export function StudyActivityPlaceholder(props: StudyActivityPlaceholderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useStableId('ema-title');
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const mode: ThemeMode = props.theme === 'light' || props.theme === 'dark' ? props.theme : prefersDark ? 'dark' : 'light';
  const fonts = props.fonts === 'bundled' ? 'bundled' : 'system';
  const tokenKey = JSON.stringify(props.tokens ?? null);
  const theme = useMemo(() => resolveTheme(mode, props.tokens), [mode, tokenKey]);
  const variables = useMemo(() => tokenVariables(fonts === 'bundled' && !props.tokens?.fontFamily ? { ...theme.tokens, fontFamily: BUNDLED_FONT_STACK } : theme.tokens, reducedMotion) as CSSProperties,
    [theme, fonts, reducedMotion, props.tokens?.fontFamily]);
  const locations = useMemo(() => assetLocations(props.assetBase), [props.assetBase]);
  useLayoutEffect(() => {
    const root = rootRef.current?.getRootNode();
    if (!root || !('adoptedStyleSheets' in root || 'head' in root)) return;
    return adoptActivityStyles(root as Document | ShadowRoot, props.assetBase).release;
  }, [props.assetBase]);
  useEffect(() => { if (fonts === 'bundled' && rootRef.current) registerFonts(rootRef.current.ownerDocument, INTER_FONT_FILES, locations); }, [fonts, locations]);

  const status = presentStatus({ status: { ui: props.state, message: UI_STATUS[props.state].message, recovery: null, persistence: 'saved', live: null }, pendingReveal: null })!;
  return (
    <div ref={rootRef} className="ema" style={variables} lang={props.locale} data-theme={mode} data-layout="auto" data-ema-ui-state={props.state} data-ema-placeholder="">
      <section className="ema-card" aria-labelledby={titleId} aria-busy={props.state === 'preparing' || undefined}>
        <header className="ema-header">
          <div className="ema-heading">
            <Heading level={props.headingLevel ?? 2} id={titleId} className="ema-title">{props.title ?? TITLE[props.state]}</Heading>
          </div>
        </header>
        <div className="ema-banner" data-tone={status.tone} data-ui-state={status.state} data-cause={status.cause} role="status">
          <span className="ema-glyph" aria-hidden="true">{status.glyph}</span>
          <div className="ema-banner-body">
            <p className="ema-banner-title">{status.title}</p>
            {status.message ? <p>{status.message}</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

export interface MountedStudyActivityPlaceholder {
  readonly element: HTMLElement;
  /** Shows another state or title without remounting. */
  update(props: StudyActivityPlaceholderProps): void;
  /** Unmounts and removes the element; idempotent. */
  dispose(): void;
}

/**
 * Plain-DOM entry: mounts the placeholder card in its own shadow root (like `mountStudyActivity`). The host element
 * carries `data-explorable-models-activity-placeholder`; dispose it before mounting the activity's surface.
 */
export function mountStudyActivityPlaceholder(container: HTMLElement, props: StudyActivityPlaceholderProps): MountedStudyActivityPlaceholder {
  if (!container || typeof container.appendChild !== 'function' || !container.ownerDocument) throw new TypeError('mountStudyActivityPlaceholder requires a browser HTMLElement container.');
  const element = container.ownerDocument.createElement('div');
  element.setAttribute('data-explorable-models-activity-placeholder', props.state);
  const shadow = element.attachShadow({ mode: 'open' });
  const styles = adoptActivityStyles(shadow, props.assetBase);
  container.appendChild(element);
  const root = createRoot(shadow);
  let disposed = false;
  // Rendered without flushSync: a host may mount the placeholder from inside its own render or effect.
  root.render(<StudyActivityPlaceholder {...props} />);
  return {
    element,
    update(next) {
      if (disposed) return;
      element.setAttribute('data-explorable-models-activity-placeholder', next.state);
      root.render(<StudyActivityPlaceholder {...next} />);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.unmount();
      styles.release();
      element.remove();
    },
  };
}
