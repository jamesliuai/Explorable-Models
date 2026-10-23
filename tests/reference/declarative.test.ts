import { describe, it, expect } from 'vitest';
import fixtures from './fixtures/declarative.json';
import { createPreset } from '../../packages/core/src/presets.js';
import { evaluateDocument } from '../../packages/core/src/declarative/evaluation.js';
describe('declarative reference cases outside candidate documents', () => {
    for (const fixture of fixtures.cases)
        it(`${fixture.preset} matches separately stated arithmetic`, () => {
            const document = createPreset(fixture.preset), params = Object.fromEntries(Object.entries(document.parameters).map(([key, spec]) => [key, spec.value]));
            const frame = evaluateDocument({ document, params, time: fixture.time });
            if (fixture.frameTime !== undefined)
                expect(frame.time).toBeCloseTo(fixture.frameTime, 12);
            if (fixture.terminal !== undefined)
                expect(frame.terminal).toBe(fixture.terminal);
            for (const [key, reference] of Object.entries(fixture.quantities)) {
                const actual = frame.quantities[key];
                expect(actual.status).toBe('valid');
                if (Array.isArray(reference)) {
                    expect(Array.isArray(actual.value)).toBe(true);
                    reference.forEach((value, index) => expect((actual.value as number[])[index]).toBeCloseTo(value, 12));
                }
                else if (reference !== undefined)
                    expect(actual.value).toBeCloseTo(reference, 12);
            }
        });
    it('retains supplied observation values without inferring a fit', () => {
        const document = createPreset('supplied-data');
        const frame = evaluateDocument({ document, params: { slope: 2, intercept: 1 }, time: 0 });
        expect(frame.series.observations).toEqual([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
        expect(frame.series.overlay.filter(point => point.x === 0 || point.x === 1 || point.x === 2)).toEqual(frame.series.observations);
    });
});
