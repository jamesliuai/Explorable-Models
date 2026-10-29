/**
 * Parameter controls, scenarios and Reset experiment (report §9, §10.2, A33, A39–A40). Each control offers a native
 * range slider (pointer and keyboard previews), exact numeric entry with an Apply button, and a display-unit selector
 * when the projection allows more than one unit. Gesture semantics:
 *
 * - pointerdown → beginPreview; input → updatePreview (the binding coalesces); pointerup → commitPreview, exactly
 *   once, with the gesture's own kind as provenance (`pointer`, never `exact`); value changes the release produces in
 *   the same task (Firefox's release-position `change`) are part of that release, not a new gesture. The slider takes
 *   no explicit pointer capture (the native input tracks its pressed pointer; WebKit's thumb stops following the
 *   pointer under an explicit capture);
 * - pointercancel (including a touch that turns into a page scroll: the slider allows vertical panning) and lost
 *   pointer capture → cancelPreview; Escape → cancelPreview. After a cancelled pointer gesture the slider ignores
 *   further value changes from that still-pressed pointer until it is released, so moving on after Escape can
 *   neither start nor commit another run;
 * - blur: one rule for sliders and draggable points (Scene2D): losing focus cancels any unfinished gesture, pointer or
 *   keyboard, with reason `blur` — a gesture commits only on its own completion event. A pressed slider takes focus
 *   (as a pressed point does); the blur WebKit on macOS performs while it handles the press of a range input belongs
 *   to the press and cancels nothing;
 * - arrow/Page/Home/End keys → one keyboard preview committed on key up; Enter commits;
 * - assistive-technology value changes without a key or pointer gesture commit at once;
 * - pressing again while the previous release is still committing: the slider follows the input at once and the
 *   preview starts from the state that commit produces (`GestureLane`); the earlier commit never resets the value of
 *   the gesture that is still held;
 * - a preview ended elsewhere (navigation, a host stage change, a revoked policy, another surface) ends the gesture:
 *   the slider shows the committed value again and neither the held pointer nor the held key commits anything;
 * - typed drafts (including IME composition) are never cleared by validation; Enter during composition does not
 *   apply; invalid input is explained inline.
 * Fixed or disabled controls stay focusable with `aria-disabled` and a visible reason, including the reason the whole
 * card is inert (paused by the host, waiting for permissions or saving); hidden controls are absent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { GestureKind, ProjectedControl, ProjectedScenario } from '@explorable-models/activity';
import { unitLabel } from '@explorable-models/core/model';
import { checkDraft, decimalSeparator, formatShown } from '../format.js';
import { PreviewGesture } from '../runtime.js';
import { Heading, useRoving, useRuntime, useStableId } from './context.js';

const KEY_STEPS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
const draftText = (value: number, locale?: string) => {
  const text = Number.isFinite(value) ? String(value) : '';
  return decimalSeparator(locale) === ',' ? text.replace('.', ',') : text;
};

export function ParameterControl({ control, activePreviewId }: { control: ProjectedControl; activePreviewId: string | null }) {
  const runtime = useRuntime();
  const { binding, locale } = runtime;
  const ids = { label: useStableId('ema-control'), hint: useStableId('ema-hint'), reason: useStableId('ema-reason'), error: useStableId('ema-error'), input: useStableId('ema-input') };
  const [sliderDraft, setSliderDraft] = useState<number | null>(null);
  const [draft, setDraft] = useState(() => draftText(control.value, locale));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const pointerId = useRef<number | null>(null);
  /** Pointer whose gesture was cancelled while still pressed; its value changes are ignored until it is released. */
  const suppressed = useRef<number | null>(null);
  /** Pointer whose press is still being handled (the task of its pointerdown); a blur in that task is the press's own. */
  const pressing = useRef<number | null>(null);
  const keyGesture = useRef(false);
  /** Incremented when a gesture begins; a completion that settles after a newer gesture began leaves its value alone. */
  const generation = useRef(0);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const { lane } = runtime;
  // One controller per binding and parameter; runtime callbacks are read through a ref so re-renders keep the gesture.
  const gesture = useMemo(() => new PreviewGesture(binding, control.parameter, {
    onFailure: diagnostics => { runtimeRef.current.fail(diagnostics); setError(diagnostics[0]?.message ?? null); },
    isDisposed: () => runtimeRef.current.disposed(), operationId: () => runtimeRef.current.opId(), lane,
  }), [binding, control.parameter, lane]);

  const disabled = control.mode === 'fixed' || !!control.disabledReason || runtime.busy || !!runtime.inert;
  const reason = runtime.inert ?? control.disabledReason ?? (control.mode === 'fixed' ? 'Fixed in this part of the activity.' : null);
  const shown = sliderDraft ?? control.previewValue ?? control.value;
  const tentative = sliderDraft !== null || control.previewValue !== undefined;
  const unit = control.unitLabel ? ` ${control.unitLabel}` : '';

  // Keep the exact field in step with committed values unless the learner is editing it.
  useEffect(() => { if (!dirty) setDraft(draftText(control.value, locale)); }, [control.value, dirty, locale]);
  // The activity moved on under the gesture (its preview ended elsewhere: navigation, a host stage change, a revoked
  // policy, another surface): the gesture stays held but commits nothing, and the slider shows the committed value.
  useEffect(() => { if (gesture.sync(binding.getProjection())) setSliderDraft(null); }, [activePreviewId, control, binding, gesture]);
  useEffect(() => () => { if (gesture.active) gesture.cancel('blur'); }, [gesture]);

  const begin = (kind: GestureKind) => { generation.current++; gesture.begin(kind); };
  const finish = async (commit: boolean, reasonCode: 'escape' | 'pointercancel' | 'blur' = 'pointercancel') => {
    if (!commit && pointerId.current !== null) suppressed.current = pointerId.current;
    pointerId.current = null;
    keyGesture.current = false;
    const mine = generation.current;
    if (commit) {
      // A refused last value commits nothing; its explanation stays until the learner changes something else.
      const rejected = gesture.rejected;
      const outcome = await gesture.commit({ [control.parameter]: control.value });
      // A gesture pressed while this one committed keeps its value on the slider.
      if (!runtime.disposed() && generation.current === mine) { setSliderDraft(null); if (outcome?.ok && !rejected) setError(null); }
    } else { gesture.cancel(reasonCode); setSliderDraft(null); }
  };

  /**
   * The release of the held pointer completes its gesture, so value changes that the release itself produces later in
   * the same task are not a new gesture: Firefox sets the value from the release position and fires `input`/`change`
   * after `pointerup` (a gesture that ended elsewhere would otherwise commit that value as an assistive-technology
   * change). The pointer's suppression lifts after the task, once the release event and any trailing `change` are done.
   */
  const release = (id: number, held: boolean) => {
    if (held) suppressed.current = id;
    if (suppressed.current === id) setTimeout(() => { if (suppressed.current === id) suppressed.current = null; }, 0);
  };
  const onSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (disabled || suppressed.current !== null || gesture.state === 'ended') return;
    const value = Number(event.currentTarget.value);
    if (!Number.isFinite(value)) return;
    setSliderDraft(value);
    if (!gesture.active) {
      // A value change without pointer or key gesture (assistive technology): one immediate commit.
      begin('keyboard');
      gesture.update(value);
      void finish(true);
      return;
    }
    gesture.update(value);
  };
  const onSliderKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) { if (KEY_STEPS.has(event.key)) event.preventDefault(); return; }
    if (event.key === 'Escape' && gesture.active) { event.preventDefault(); void finish(false, 'escape'); return; }
    if (event.key === 'Enter' && gesture.active) { event.preventDefault(); void finish(true); return; }
    if (KEY_STEPS.has(event.key) && !gesture.active) { keyGesture.current = true; begin('keyboard'); }
  };
  const onSliderKeyUp = (event: KeyboardEvent<HTMLInputElement>) => { if (KEY_STEPS.has(event.key) && keyGesture.current && pointerId.current === null) void finish(true); };

  const apply = async () => {
    if (disabled || composing.current || runtime.settling || runtime.scienceBusy()) return;
    const check = checkDraft(control, draft, locale);
    if (!check.ok) { setError(check.message); runtime.announce(check.message, 'error'); return; }
    // Applying the committed value again would restart the run for no change; treat it as a no-op.
    if (check.value === control.value) { setError(null); setDirty(false); return; }
    const outcome = await runtime.run(() => binding.commitParameters({ operationId: runtime.opId(), ...binding.getProjection().guards, displayValues: { [control.parameter]: check.value } }), 'science');
    if (runtime.disposed()) return;
    if (outcome?.ok) { setError(null); setDirty(false); }
    else if (outcome && !outcome.ok) setError(outcome.diagnostics[0]?.message ?? 'That value was not applied.');
  };
  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composing.current) return;
    if (event.key === 'Enter') { event.preventDefault(); void apply(); }
    else if (event.key === 'Escape' && dirty) { event.preventDefault(); setDraft(draftText(control.value, locale)); setDirty(false); setError(null); }
  };

  const describedBy = [ids.hint, reason ? ids.reason : null, error ? ids.error : null].filter(Boolean).join(' ');
  return (
    <div className="ema-control" role="group" aria-labelledby={ids.label} data-parameter={control.parameter}>
      <div className="ema-control-head">
        <span className="ema-control-label" id={ids.label}>{control.label}</span>
        <output className="ema-control-value" data-tentative={tentative || undefined} aria-live="off">
          {formatShown(shown, locale)}{unit}{tentative ? <span className="ema-badge">preview</span> : null}
        </output>
      </div>
      {control.slider ? (
        <input
          type="range" className="ema-slider" aria-labelledby={ids.label} aria-describedby={describedBy}
          min={control.min} max={control.max} step={control.integer ? Math.max(1, control.step) : control.step > 0 ? control.step : 'any'} value={shown}
          aria-valuetext={`${formatShown(shown, locale)}${unit}${tentative ? ' (preview, not applied yet)' : ''}`}
          aria-disabled={disabled || undefined} onChange={onSliderChange} onKeyDown={onSliderKeyDown} onKeyUp={onSliderKeyUp}
          onPointerDown={event => {
            if (disabled) { event.preventDefault(); return; }
            if (event.button !== 0 || gesture.active) return;
            suppressed.current = null;
            const id = event.pointerId, input = event.currentTarget;
            pointerId.current = id;
            // No explicit setPointerCapture: the native range input keeps the pressed pointer itself (Chromium, Firefox
            // and WebKit deliver the release to it, also outside its box), and an explicit capture stops WebKit's thumb
            // from following the pointer at all.
            // The pressed slider takes focus, as a pressed point does, so Escape and the blur rule apply to the pointer
            // drag. WebKit on macOS gives a pressed range input no focus and blurs the focused element while it handles
            // the press: that blur belongs to the press, and focus moves to the slider once the press is handled.
            pressing.current = id;
            input.focus({ preventScroll: true });
            setTimeout(() => {
              if (pressing.current === id) pressing.current = null;
              const root = input.getRootNode() as Document | ShadowRoot;
              if (pointerId.current === id && gesture.active && !runtimeRef.current.disposed() && input.isConnected && root.activeElement !== input) input.focus({ preventScroll: true });
            }, 0);
            begin('pointer');
          }}
          onPointerUp={event => { const held = pointerId.current === event.pointerId; release(event.pointerId, held); if (held) void finish(true); }}
          onPointerCancel={event => { release(event.pointerId, false); if (pointerId.current === event.pointerId) void finish(false, 'pointercancel'); }}
          onLostPointerCapture={event => { release(event.pointerId, false); if (pointerId.current === event.pointerId) void finish(false, 'pointercancel'); }}
          onBlur={() => { if (gesture.active && (pressing.current === null || pressing.current !== pointerId.current)) void finish(false, 'blur'); }}
        />
      ) : null}
      {control.exact ? (
        <div className="ema-exact">
          <label className="ema-sr" htmlFor={ids.input}>Exact value for {control.label}{unit ? ` in ${control.unitLabel}` : ''}</label>
          <input
            id={ids.input} className="ema-input" type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={draft}
            readOnly={disabled} aria-disabled={disabled || undefined} aria-invalid={error ? true : undefined} aria-describedby={describedBy}
            onChange={event => { setDraft(event.currentTarget.value); setDirty(true); }}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={onDraftKeyDown}
          />
          {control.displayUnits.length > 1 ? (
            <select className="ema-select" aria-label={`Unit for ${control.label}`} value={control.displayUnit} aria-disabled={runtime.busy || undefined}
              onChange={event => { const unitId = event.currentTarget.value as ProjectedControl['displayUnit']; void runtime.run(() => binding.setDisplayUnit({ operationId: runtime.opId(), expectedPresentationRevision: binding.getProjection().presentationRevision, parameter: control.parameter, unit: unitId }), 'presentation'); }}>
              {control.displayUnits.map(unitId => <option key={unitId} value={unitId}>{unitLabel(unitId, true)}{unitLabel(unitId) ? ` (${unitLabel(unitId)})` : ''}</option>)}
            </select>
          ) : control.unitLabel ? <span className="ema-unit">{control.unitLabel}</span> : null}
          <button type="button" className="ema-button" aria-disabled={disabled || runtime.settling || undefined} onClick={() => void apply()}>Apply</button>
        </div>
      ) : null}
      {reason ? <p className="ema-reason" id={ids.reason}><span className="ema-glyph" aria-hidden="true">–</span>{reason}</p> : null}
      {error ? <p className="ema-error" id={ids.error}><span className="ema-glyph" aria-hidden="true">!</span>{error}</p> : null}
      <p className="ema-control-hint" id={ids.hint}>{control.description} Range {formatShown(control.min, locale)} to {formatShown(control.max, locale)}{unit}.</p>
    </div>
  );
}

export function Scenarios({ scenarios, title, headingLevel }: { scenarios: ProjectedScenario[]; title: string; headingLevel: number }) {
  const runtime = useRuntime();
  const roving = useRoving(scenarios.length, 'horizontal');
  const headingId = useStableId('ema-scenarios');
  const describe = useStableId('ema-scenario-desc');
  const reasonId = useStableId('ema-scenario-reason');
  const active = scenarios.find(scenario => scenario.active);
  const unavailable = runtime.busy || runtime.settling || !!runtime.inert;
  const apply = (scenario: ProjectedScenario) => {
    // Checked synchronously: rapid activations of two scenarios start one guarded command, never two.
    if (unavailable || runtime.scienceBusy()) return;
    void runtime.run(() => runtime.binding.applyScenario({ operationId: runtime.opId(), ...runtime.binding.getProjection().guards, scenarioId: scenario.scenarioId }), 'science');
  };
  return (
    <section className="ema-panel" aria-labelledby={headingId}>
      <Heading level={headingLevel} id={headingId} className="ema-panel-title">{title}</Heading>
      <div className="ema-scenarios" role="toolbar" aria-label={title} aria-describedby={runtime.inert ? `${describe} ${reasonId}` : describe} onKeyDown={roving.onKeyDown}>
        {scenarios.map((scenario, index) => (
          <button key={scenario.scenarioId} type="button" className="ema-button" aria-pressed={scenario.active} title={scenario.description}
            aria-describedby={runtime.inert ? reasonId : undefined} aria-disabled={unavailable || undefined} {...roving.itemProps(index)} onClick={() => apply(scenario)}>{scenario.label}</button>
        ))}
      </div>
      <p className="ema-panel-note" id={describe}>{active ? active.description : 'Each scenario starts a new run from the beginning.'}</p>
      {runtime.inert ? <p className="ema-reason" id={reasonId}><span className="ema-glyph" aria-hidden="true">–</span>{runtime.inert}</p> : null}
    </section>
  );
}

/**
 * Reset experiment (report §9): a new run from the activity's starting parameters under the same approved template,
 * through the guarded `resetExperiment` command (journaled as `parameters.committed` with cause `reset`). It is a
 * separate action from Restart (the same run back to its first position) and Reset view (presentation only), and it
 * never erases activity history or exposure records. The surface offers it only while some control is interactive.
 */
export function ResetExperiment({ previewActive }: { previewActive: boolean }) {
  const runtime = useRuntime();
  const hintId = useStableId('ema-reset-hint');
  const reasonId = useStableId('ema-reset-reason');
  const unavailable = runtime.busy || runtime.settling || previewActive || !!runtime.inert;
  const reset = () => {
    if (unavailable || runtime.scienceBusy()) return;
    void runtime.run(() => runtime.binding.resetExperiment({ operationId: runtime.opId(), ...runtime.binding.getProjection().guards }), 'science');
  };
  return (
    <div className="ema-reset" data-ema-action="reset-experiment">
      <button type="button" className="ema-button" aria-describedby={runtime.inert ? `${hintId} ${reasonId}` : hintId} aria-disabled={unavailable || undefined} onClick={reset}>
        <span aria-hidden="true">⟲</span>Reset experiment
      </button>
      <p className="ema-control-hint" id={hintId}>Starts a new run from the starting values. Earlier work stays recorded.</p>
      {runtime.inert ? <p className="ema-reason" id={reasonId}><span className="ema-glyph" aria-hidden="true">–</span>{runtime.inert}</p> : null}
    </div>
  );
}

