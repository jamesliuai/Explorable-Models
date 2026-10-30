/**
 * Theme tokens for the Study Harness learner surface (report §10.1). Tokens become CSS custom properties on the
 * surface root through CSSOM (React style props), never through parsed style attributes (native.md N4).
 *
 * Host overrides are data, not CSS: every override is validated, and an override that would hide a meaningful state
 * (low-contrast text, status, focus or mark colours, transparent or non-literal colours, unsafe font/size values) is
 * ignored and reported, so host styling cannot obscure undefined, error, boundary or focus states.
 */

export type ThemeMode = 'light' | 'dark';
export type ThemePreference = ThemeMode | 'system';

export interface ThemeTokens {
  background: string;
  surface: string;
  surfaceStrong: string;
  /** Decorative separators only. */
  border: string;
  /** Boundaries of interactive controls (WCAG 1.4.11 non-text contrast). */
  borderStrong: string;
  text: string;
  textMuted: string;
  primary: string;
  secondary: string;
  accent: string;
  muted: string;
  positive: string;
  negative: string;
  warning: string;
  reference: string;
  focus: string;
  error: string;
  /** Text drawn on `primary` where a surface fills a shape with the primary mark colour. */
  onPrimary: string;
  /**
   * Fill of the one primary action (a host's next action, Apply in a banner, a return action). Neutral by default
   * (light on dark, dark on light): colour is reserved for data and meaningful states, not for buttons.
   */
  action: string;
  /** Text drawn on `action`. */
  onAction: string;
  /** Interface font: controls, labels, values, diagram text. */
  fontFamily: string;
  /** Teaching prose (activity title and stage instruction): a book serif that sits beside typeset mathematics. */
  proseFamily: string;
  monoFamily: string;
  /** Base text size; relative units keep 200 % text resizing working. */
  fontSize: string;
  radius: string;
  /** Base spacing unit; the spacing scale is derived from it. */
  space: string;
  /** Duration of non-essential transitions; forced to 0ms under reduced motion. */
  motionDuration: string;
}

export const COLOR_TOKENS = [
  'background', 'surface', 'surfaceStrong', 'border', 'borderStrong', 'text', 'textMuted', 'primary', 'secondary', 'accent', 'muted',
  'positive', 'negative', 'warning', 'reference', 'focus', 'error', 'onPrimary', 'action', 'onAction',
] as const satisfies readonly (keyof ThemeTokens)[];
export type ColorToken = typeof COLOR_TOKENS[number];

/** Mark roles (contracts MarkRole) drawn with these tokens; every role also has a non-colour cue (dash/marker/label). */
export const ROLE_TOKENS = ['primary', 'secondary', 'accent', 'muted', 'positive', 'negative', 'warning', 'reference'] as const satisfies readonly ColorToken[];

export const SYSTEM_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const BUNDLED_FONT_STACK = `'Inter Variable', ${SYSTEM_FONT_STACK}`;
/**
 * Default `proseFamily`. Palatino comes first because it carries the subscripts and Greek letters used in teaching text
 * (x₀, η); a generic system serif may lack them and fall back to mismatched glyphs.
 */
export const PROSE_FONT_STACK = "Palatino, 'Palatino Linotype', 'Book Antiqua', ui-serif, Georgia, serif";
const MONO_STACK = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const SHARED = { fontFamily: SYSTEM_FONT_STACK, proseFamily: PROSE_FONT_STACK, monoFamily: MONO_STACK, fontSize: '0.9375rem', radius: '7px', space: '0.5rem', motionDuration: '140ms' };

/**
 * Warm-neutral palettes (0.3 presentation): quiet surfaces, hairline separators and a neutral primary action, with
 * colour kept for the data roles and meaningful states. Every pair in `CONTRAST_RULES` passes in both palettes.
 */
export const LIGHT_TOKENS: Readonly<ThemeTokens> = Object.freeze({
  background: '#fbfaf7', surface: '#f3f2ee', surfaceStrong: '#e8e6e0', border: '#dedbd3', borderStrong: '#8b877e', text: '#1f1e1c', textMuted: '#57544d',
  primary: '#255f9e', secondary: '#6a4e9f', accent: '#a5521f', muted: '#6f6b63', positive: '#2c6e3f', negative: '#b0392b', warning: '#7b5800',
  reference: '#3e3b36', focus: '#1f1e1c', error: '#b0392b', onPrimary: '#ffffff', action: '#1f1e1c', onAction: '#fbfaf7', ...SHARED,
});
export const DARK_TOKENS: Readonly<ThemeTokens> = Object.freeze({
  background: '#1a1a19', surface: '#212120', surfaceStrong: '#2a2a28', border: '#31312e', borderStrong: '#77746d', text: '#edebe6', textMuted: '#bdbab3',
  primary: '#86b2e6', secondary: '#b9a1e4', accent: '#e8975c', muted: '#99958d', positive: '#8cc79a', negative: '#e58a7b', warning: '#dcae62',
  reference: '#d2cec6', focus: '#edebe6', error: '#e58a7b', onPrimary: '#141413', action: '#edebe6', onAction: '#141413', ...SHARED,
});
export const DEFAULT_TOKENS: Readonly<Record<ThemeMode, Readonly<ThemeTokens>>> = Object.freeze({ light: LIGHT_TOKENS, dark: DARK_TOKENS });

/**
 * Minimum contrast of a foreground token against the backgrounds it is drawn on. Text-like tokens need 4.5:1
 * (WCAG 1.4.3); graphics, focus indicators and control boundaries need 3:1 (WCAG 1.4.11).
 */
export const CONTRAST_RULES: readonly { token: ColorToken; against: readonly ColorToken[]; min: number }[] = Object.freeze([
  { token: 'text', against: ['background', 'surface', 'surfaceStrong'], min: 4.5 },
  { token: 'textMuted', against: ['background', 'surface'], min: 4.5 },
  { token: 'error', against: ['background', 'surface'], min: 4.5 },
  { token: 'negative', against: ['background', 'surface'], min: 4.5 },
  { token: 'positive', against: ['background', 'surface'], min: 4.5 },
  { token: 'warning', against: ['background', 'surface'], min: 4.5 },
  { token: 'focus', against: ['background', 'surface'], min: 3 },
  { token: 'borderStrong', against: ['background', 'surface'], min: 3 },
  { token: 'primary', against: ['background', 'surface'], min: 3 },
  { token: 'secondary', against: ['background', 'surface'], min: 3 },
  { token: 'accent', against: ['background', 'surface'], min: 3 },
  { token: 'muted', against: ['background', 'surface'], min: 3 },
  { token: 'reference', against: ['background', 'surface'], min: 3 },
  { token: 'onPrimary', against: ['primary'], min: 4.5 },
  { token: 'action', against: ['background', 'surface'], min: 3 },
  { token: 'onAction', against: ['action'], min: 4.5 },
]);

export type Rgb = [number, number, number];

/** Parses `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgb(r g b)` only; anything else (named, transparent, var(), url()) is null. */
export function parseColor(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  let match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (match) {
    const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  }
  match = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/.exec(text);
  if (!match) return null;
  const rgb = match.slice(1, 4).map(Number) as Rgb;
  return rgb.every(channel => channel <= 255) ? rgb : null;
}

/** WCAG relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two colours (1–21), or 0 when either is not a parseable literal colour. */
export function contrastRatio(a: string, b: string): number {
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return 0;
  const [hi, lo] = [relativeLuminance(x), relativeLuminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

export interface RejectedToken { token: string; reason: string }
export interface ResolvedTheme { mode: ThemeMode; tokens: ThemeTokens; rejected: RejectedToken[] }

const LENGTH_RULES: Partial<Record<keyof ThemeTokens, { units: Record<string, [number, number]> }>> = {
  fontSize: { units: { px: [12, 24], rem: [0.75, 1.5], em: [0.75, 1.5] } },
  radius: { units: { px: [0, 16], rem: [0, 1] } },
  space: { units: { px: [2, 16], rem: [0.125, 1] } },
  motionDuration: { units: { ms: [0, 400] } },
};
const FONT_PATTERN = /^[A-Za-z0-9 ,'"_-]{1,200}$/;

function validateScalar(token: keyof ThemeTokens, value: unknown): string | null {
  if (typeof value !== 'string') return 'not a string';
  if (token === 'fontFamily' || token === 'monoFamily' || token === 'proseFamily') return FONT_PATTERN.test(value) ? null : 'font families may contain only letters, digits, spaces, quotes, commas, hyphens and underscores';
  const rule = LENGTH_RULES[token];
  if (!rule) return 'unknown token';
  const match = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(value.trim());
  const range = match ? rule.units[match[2]] : undefined;
  if (!match || !range) return `expected one of ${Object.keys(rule.units).join(', ')}`;
  const amount = Number(match[1]);
  return amount >= range[0] && amount <= range[1] ? null : `outside the safe range ${range[0]}–${range[1]}${match[2]}`;
}

const failingRules = (tokens: ThemeTokens) => CONTRAST_RULES.flatMap(rule => rule.against
  .filter(other => contrastRatio(tokens[rule.token], tokens[other]) < rule.min)
  .map(other => ({ ...rule, other })));

/**
 * Merges host overrides into the default palette for `mode`. Unknown keys, malformed values and overrides that break
 * a contrast rule are ignored (the default stays) and listed in `rejected`. Deterministic: a background override that
 * makes a default foreground unreadable is itself rejected.
 */
export function resolveTheme(mode: ThemeMode, overrides: Partial<ThemeTokens> | undefined): ResolvedTheme {
  const base = DEFAULT_TOKENS[mode];
  const tokens: ThemeTokens = { ...base };
  const rejected: RejectedToken[] = [];
  if (!overrides || typeof overrides !== 'object') return { mode, tokens, rejected };
  const accepted = new Set<keyof ThemeTokens>();
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(base, key)) { rejected.push({ token: key, reason: 'unknown token' }); continue; }
    const token = key as keyof ThemeTokens;
    if ((COLOR_TOKENS as readonly string[]).includes(token)) {
      if (!parseColor(value)) { rejected.push({ token, reason: 'only opaque #rgb, #rrggbb or rgb() colours are accepted' }); continue; }
    } else {
      const problem = validateScalar(token, value);
      if (problem) { rejected.push({ token, reason: problem }); continue; }
    }
    tokens[token] = String(value).trim();
    accepted.add(token);
  }
  // Revert overridden foregrounds first, then overridden backgrounds, until every rule passes.
  for (let guard = 0; guard < COLOR_TOKENS.length * 2; guard++) {
    const failures = failingRules(tokens);
    if (!failures.length) break;
    const failure = failures[0];
    const culprit = accepted.has(failure.token) ? failure.token : accepted.has(failure.other) ? failure.other : null;
    if (!culprit) break;
    tokens[culprit] = base[culprit];
    accepted.delete(culprit);
    rejected.push({ token: culprit, reason: `contrast of ${failure.token} on ${failure.other} would fall below ${failure.min}:1` });
  }
  return { mode, tokens, rejected };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
/** CSS custom properties (`--ema-*`) for a resolved token set; applied with CSSOM. */
export function tokenVariables(tokens: ThemeTokens, reducedMotion = false): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) variables[`--ema-${kebab(key)}`] = value;
  if (reducedMotion) variables['--ema-motion-duration'] = '0ms';
  return variables;
}
