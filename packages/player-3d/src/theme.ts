/**
 * Colours for the WebGL scene, read from the learner surface's `--eka-*` custom properties (so host themes, dark mode
 * and contrast-validated overrides apply to the 3D view as well) with the surface's default palettes as fallback.
 * Axes use the negative (red), positive (green) and primary (blue) tokens for x, y and z; colour is never the only
 * cue: each axis also has its own line pattern, an arrowhead and a text label.
 */
export interface SpatialTheme {
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  borderStrong: string;
  roles: Record<string, string>;
  axes: [string, string, string];
}

const LIGHT = {
  background: '#ffffff', surface: '#f5f7f9', text: '#17212b', textMuted: '#4a5866', border: '#c9d2db', borderStrong: '#7a8692',
  primary: '#1d5fa6', secondary: '#6a4c9c', accent: '#a8501a', muted: '#66727f', positive: '#1b7340', negative: '#b3261e', warning: '#7f5600', reference: '#38444f',
};
const DARK = {
  background: '#121820', surface: '#19212b', text: '#e7edf3', textMuted: '#aab6c2', border: '#3a4756', borderStrong: '#6f7d8c',
  primary: '#79b3f2', secondary: '#bba1ec', accent: '#f0a467', muted: '#93a0ad', positive: '#6cce93', negative: '#ff8f86', warning: '#e5bb57', reference: '#cad4de',
};
type Palette = typeof LIGHT;
const ROLES = ['primary', 'secondary', 'accent', 'muted', 'positive', 'negative', 'warning', 'reference'] as const;
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\(\s*\d{1,3}(\.\d+)?\s*,\s*\d{1,3}(\.\d+)?\s*,\s*\d{1,3}(\.\d+)?\s*(,\s*(1|1\.0+|0?\.\d+)\s*)?\))$/i;

function themeFrom(palette: Palette): SpatialTheme {
  const roles: Record<string, string> = {};
  for (const role of ROLES) roles[role] = palette[role];
  return {
    background: palette.background, surface: palette.surface, text: palette.text, textMuted: palette.textMuted, border: palette.border, borderStrong: palette.borderStrong,
    roles, axes: [palette.negative, palette.positive, palette.primary],
  };
}
export const LIGHT_THEME: Readonly<SpatialTheme> = Object.freeze(themeFrom(LIGHT));
export const DARK_THEME: Readonly<SpatialTheme> = Object.freeze(themeFrom(DARK));

const kebab = (name: string) => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

/** Theme from the computed `--eka-*` properties of `element`; malformed or missing values fall back to the defaults. */
export function readTheme(element: Element): SpatialTheme {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const dark = element.closest('[data-theme]')?.getAttribute('data-theme') === 'dark'
    || (!element.closest('[data-theme]') && !!view?.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const fallback: Palette = dark ? DARK : LIGHT;
  const read = (key: keyof Palette): string => {
    const value = style?.getPropertyValue(`--eka-${kebab(key)}`).trim() ?? '';
    return COLOR.test(value) ? value : fallback[key];
  };
  const palette = Object.fromEntries((Object.keys(LIGHT) as (keyof Palette)[]).map(key => [key, read(key)])) as Palette;
  return themeFrom(palette);
}

export const sameTheme = (a: SpatialTheme, b: SpatialTheme): boolean => JSON.stringify(a) === JSON.stringify(b);
export const roleColor = (theme: SpatialTheme, role: string): string => theme.roles[role] ?? theme.roles.primary!;
