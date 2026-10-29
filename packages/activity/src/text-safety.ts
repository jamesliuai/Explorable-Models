/**
 * Hostile-TeX screen shared by every channel that accepts TeX for learner-visible output (report §10.3 and §16, A35):
 * the learner surface's math renderer (`@explorable-models/player/activity`) and the agent tools' screen for exploratory
 * content (`@explorable-models/agent`) both import this list, so the two can never disagree about what is refused.
 *
 * The screen is defence in depth: KaTeX still runs with `trust: false`, bounded expansion and size, and a fresh macro
 * object per render. Refused here, before any parser sees the source, are commands that define or expand macros
 * globally, reach resources (links, URLs, images, file input) or attach HTML classes, IDs, styles or data. Every check
 * is bounded: a source is measured in code points against {@link TEX_SOURCE_LIMIT} before the single linear pattern
 * runs, and the pattern never backtracks across the input.
 */

/** Maximum TeX source length in Unicode code points (the template schema's equation bound and the KaTeX input bound). */
export const TEX_SOURCE_LIMIT = 4096;

/** Commands refused in learner-visible TeX (without the backslash). A command is matched only as a whole control word. */
export const FORBIDDEN_TEX_COMMANDS: readonly string[] = Object.freeze([
  // Resources and links.
  'href', 'url', 'includegraphics', 'input', 'include',
  // HTML extensions (classes, IDs, styles, data attributes and the internal HTML/MathML switch).
  'htmlClass', 'htmlId', 'htmlStyle', 'htmlData', 'html@mathml',
  // Macro definition and expansion control.
  'def', 'gdef', 'edef', 'xdef', 'let', 'futurelet', 'global', 'expandafter', 'newcommand', 'renewcommand', 'providecommand',
  'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'csname', 'endcsname',
]);

const escape = (command: string): string => command.replace(/[.*+?^${}()|[\]\\@]/g, character => `\\${character}`);
/** `\command` not followed by another letter (TeX control words end at the first non-letter; `@` counts as a letter here). */
const FORBIDDEN = new RegExp(`\\\\(${FORBIDDEN_TEX_COMMANDS.map(escape).join('|')})(?![A-Za-z@])`);

/** Length of `text` in Unicode code points (a surrogate pair counts once). */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

/**
 * The first forbidden command in `text` (without its backslash), or null. The caller bounds `text` first, for example
 * with {@link checkTexSource}; the pattern is a single alternation with a one-character lookahead.
 */
export function forbiddenTexCommand(text: string): string | null {
  return FORBIDDEN.exec(text)?.[1] ?? null;
}

export type TexSourceCheck =
  | { ok: true }
  | { ok: false; reason: 'not-text' | 'too-long' | 'rejected-command'; detail: string };

/**
 * Bounded screen of a TeX source: it must be a string of at most `limit` code points (checked before the pattern runs)
 * with no {@link FORBIDDEN_TEX_COMMANDS}. Details name the limit or the command only, never other source text.
 */
export function checkTexSource(source: unknown, limit = TEX_SOURCE_LIMIT): TexSourceCheck {
  if (typeof source !== 'string') return { ok: false, reason: 'not-text', detail: 'The equation source is not text.' };
  // Code points never outnumber UTF-16 units, so a short string skips the count.
  if (source.length > limit) {
    const length = codePointLength(source);
    if (length > limit) return { ok: false, reason: 'too-long', detail: `The equation source has ${length} characters; the limit is ${limit}.` };
  }
  const command = forbiddenTexCommand(source);
  return command ? { ok: false, reason: 'rejected-command', detail: `The command \\${command} is not allowed in learner equations.` } : { ok: true };
}

/** KaTeX bounds every learner equation is rendered and checked with (report §10.3): macro expansions and size in em. */
export const TEX_RENDER_LIMITS = Object.freeze({ maxExpand: 1000, maxSize: 20 });

/** Options a bounded TeX parser applies: no trust, the {@link TEX_RENDER_LIMITS}, a fresh macro object, no global group. */
export interface TexParseOptions {
  displayMode: boolean;
  trust: false;
  maxExpand: number;
  maxSize: number;
  throwOnError: true;
  strict: 'ignore';
  macros: Record<string, string>;
  globalGroup: false;
}
/** Fresh bounded parse options (a new, prototype-free macro object every call: no macro state is ever shared). */
export function texParseOptions(displayMode = true): TexParseOptions {
  return {
    displayMode, trust: false, maxExpand: TEX_RENDER_LIMITS.maxExpand, maxSize: TEX_RENDER_LIMITS.maxSize, throwOnError: true, strict: 'ignore',
    macros: Object.create(null) as Record<string, string>, globalGroup: false,
  };
}
/**
 * A bounded TeX parser supplied by trusted toolkit code (for example KaTeX's `renderToString` with the given options);
 * it throws when the source does not parse. Nothing here bundles a parser, so the learner entry stays small.
 */
export type TexParser = (source: string, options: TexParseOptions) => unknown;

/** One TeX source an author wrote, as the renderer receives it with a representative value substituted. */
export interface TexSource {
  /** JSON path of the authored field (`$.equations[2].tex`, `$.parameters.eta.symbol`). */
  path: string;
  /** What the source is, for messages (`equation "det"`). */
  what: string;
  /** The source with every placeholder replaced by one representative value form (see {@link TEX_VALUE_FORMS}). */
  tex: string;
  /** The representative value form substituted, or null when the source has no placeholders. */
  form: TexValueForm | null;
}
/**
 * The forms a `{{q:id}}` placeholder takes in projected TeX (activity projection `texValue`): a signed decimal, an
 * approximate value in scientific notation, a vector in parentheses and a status as text. Each is checked, so an
 * equation parses whatever the frame later shows (an `\frac{{q:a}}{2}` that parses with a numeral fails with text).
 */
export const TEX_VALUE_FORMS = Object.freeze({
  numeral: '-1.25',
  scientific: '\\approx 1.25 \\times 10^{-5}',
  vector: '\\left(-1.25,\\,2\\right)',
  status: '\\text{undefined}',
} as const);
export type TexValueForm = keyof typeof TEX_VALUE_FORMS;

const PLACEHOLDER_PATTERN = /\{\{q:([A-Za-z0-9_.:-]{1,128})\}\}/g;
type QuantityShapes = Readonly<Record<string, { shape?: { kind: string } }>>;

/**
 * Every TeX source of a template's equations as the renderer can receive it: one source per representative value form
 * that the substituted quantities can take (by their declared shape; every value can also be a status), or the TeX as
 * written when it has no placeholders. Sources failing the hostile-TeX screen are left to {@link checkTexSource}.
 */
export function templateTexSources(template: { equations: readonly { id: string; tex: string }[] }, quantities: QuantityShapes = {}): TexSource[] {
  const out: TexSource[] = [];
  template.equations.forEach((equation, index) => {
    const path = `$.equations[${index}].tex`, what = `equation ${JSON.stringify(equation.id)}`;
    const ids = [...equation.tex.matchAll(PLACEHOLDER_PATTERN)].map(match => match[1]!);
    if (!ids.length) { out.push({ path, what, tex: equation.tex, form: null }); return; }
    const forms = new Set<TexValueForm>(['status']);
    for (const id of ids) {
      const kind = quantities[id]?.shape?.kind;
      if (kind === 'vector') forms.add('vector');
      else if (kind !== 'category') { forms.add('numeral'); forms.add('scientific'); }
    }
    for (const form of (Object.keys(TEX_VALUE_FORMS) as TexValueForm[]).filter(candidate => forms.has(candidate)))
      out.push({ path, what, tex: equation.tex.replace(PLACEHOLDER_PATTERN, () => TEX_VALUE_FORMS[form]), form });
  });
  return out;
}

/** The declared TeX-safe symbols of a model manifest's parameters and quantities (presentation metadata). */
export function manifestTexSources(manifest: { parameters: Readonly<Record<string, { symbol?: string }>>; quantities: Readonly<Record<string, { symbol?: string }>> }): TexSource[] {
  const out: TexSource[] = [];
  for (const [kind, entries] of [['parameters', manifest.parameters], ['quantities', manifest.quantities]] as const)
    for (const [id, entry] of Object.entries(entries)) if (typeof entry.symbol === 'string' && entry.symbol) out.push({ path: `$.${kind}.${id}.symbol`, what: `the symbol of ${kind === 'parameters' ? 'parameter' : 'quantity'} ${JSON.stringify(id)}`, tex: entry.symbol, form: null });
  return out;
}

const FORM_TEXT: Readonly<Record<TexValueForm, string>> = {
  numeral: 'a value is shown as a decimal', scientific: 'a value is shown in scientific notation', vector: 'a vector is shown', status: 'a value is shown as a status word such as “undefined”',
};
/**
 * Validate-time parse of TeX sources with a bounded parser (report §10.3, §15.2): one `MATH_FALLBACK` diagnostic per
 * authored field that fails to parse (the first failing value form) — the same code a mounted surface reports when it
 * shows an equation as plain text — naming the field and the parser's reason. Sources the hostile-TeX screen refuses are
 * not parsed (semantic validation reports them). Messages never quote the source.
 */
export interface TexParseDiagnostic { code: 'MATH_FALLBACK'; path: string; message: string; recovery: string }
export function texParseDiagnostics(sources: readonly TexSource[], parse: TexParser): TexParseDiagnostic[] {
  const out: TexParseDiagnostic[] = [];
  const reported = new Set<string>();
  for (const source of sources) {
    if (reported.has(source.path) || !checkTexSource(source.tex).ok) continue;
    try { parse(source.tex, texParseOptions(true)); }
    catch (error) {
      reported.add(source.path);
      const raw = error && typeof error === 'object' && typeof (error as { rawMessage?: unknown }).rawMessage === 'string' ? (error as { rawMessage: string }).rawMessage
        : error instanceof Error ? error.message : 'the parser refused it';
      const reason = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
      out.push({
        code: 'MATH_FALLBACK', path: source.path,
        message: `The TeX of ${source.what} does not parse${source.form ? ` when ${FORM_TEXT[source.form]}` : ''}: ${reason}.${source.path.startsWith('$.equations') ? ' Learners would only ever see its plain-text form.' : ''}`,
        recovery: source.form ? 'Fix the TeX so it parses; wrap each {{q:…}} placeholder in braces where TeX expects one argument, for example \\frac{{{q:a}}}{2}.' : 'Fix the TeX so it parses with the bounded KaTeX renderer (no macros, links, HTML or unknown commands).',
      });
    }
  }
  return out;
}
