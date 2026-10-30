/**
 * Colours for the WebGL scene, read from the learner surface's `--ema-*` custom properties (so host themes, dark mode
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

// The learner surface's default palettes (`@explorable-models/player/activity` LIGHT_TOKENS / DARK_TOKENS, 0.3 warm-neutral
// presentation), repeated here so the renderer has no runtime dependency on the player package.
const LIGHT = {
  background: '#fbfaf7', surface: '#f3f2ee', text: '#1f1e1c', textMuted: '#57544d', border: '#dedbd3', borderStrong: '#8b877e',
  primary: '#255f9e', secondary: '#6a4e9f', accent: '#a5521f', muted: '#6f6b63', positive: '#2c6e3f', negative: '#b0392b', warning: '#7b5800', reference: '#3e3b36',
};
const DARK = {
  background: '#1a1a19', surface: '#212120', text: '#edebe6', textMuted: '#bdbab3', border: '#31312e', borderStrong: '#77746d',
  primary: '#86b2e6', secondary: '#b9a1e4', accent: '#e8975c', muted: '#99958d', positive: '#8cc79a', negative: '#e58a7b', warning: '#dcae62', reference: '#d2cec6',
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

/** Theme from the computed `--ema-*` properties of `element`; malformed or missing values fall back to the defaults. */
export function readTheme(element: Element): SpatialTheme {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const dark = element.closest('[data-theme]')?.getAttribute('data-theme') === 'dark'
    || (!element.closest('[data-theme]') && !!view?.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const fallback: Palette = dark ? DARK : LIGHT;
  const read = (key: keyof Palette): string => {
    const value = style?.getPropertyValue(`--ema-${kebab(key)}`).trim() ?? '';
    return COLOR.test(value) ? value : fallback[key];
  };
  const palette = Object.fromEntries((Object.keys(LIGHT) as (keyof Palette)[]).map(key => [key, read(key)])) as Palette;
  return themeFrom(palette);
}

export const sameTheme = (a: SpatialTheme, b: SpatialTheme): boolean => JSON.stringify(a) === JSON.stringify(b);
export const roleColor = (theme: SpatialTheme, role: string): string => theme.roles[role] ?? theme.roles.primary!;
