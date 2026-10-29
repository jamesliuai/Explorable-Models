/**
 * Three visible activities on the adapter's default worker budget (report §9 "Budget scratch workers across
 * activities", §18 global worker budget; A41, A42; review finding R43). In-process test workers and the memory host:
 * fixture results, not evidence about a packaged host.
 *
 * Two cards that each ran one preview keep their primary leases and an idle scratch lease. A third card's prepare must
 * not wait for one of them to be suspended: the budget reclaims an idle scratch worker for it, and the card whose
 * scratch worker was reclaimed previews again with a fresh lease.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTER_LIMITS } from '../../packages/activity/src/adapter';
import { ackCurrent, authorizeExploration, enterExplore, guards, harness, okOf, op, open, requestFor, settled, until, type Harness, type Opened } from './support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

async function previewAndCommit(opened: Opened, eta: number): Promise<void> {
  const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
  okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta } }));
  await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
  ackCurrent(opened.learner);
  okOf(await opened.learner.commitPreview({ operationId: op(), ...guards(opened.learner), previewId }));
}

describe('shared worker budget across visible activities (R43)', () => {
  it('prepares a third visible activity on the default budget while two cards hold primary and idle scratch leases', async () => {
    const h = current = harness();
    expect(ADAPTER_LIMITS.defaultWorkers).toBe(4);
    const cards: Opened[] = [];
    for (const activityId of ['act-quadratic-1', 'act-quadratic-2']) {
      const opened = await open(h, requestFor({ activityId }));
      await settled(h, activityId);
      await enterExplore(h, opened);
      await authorizeExploration(h, opened);
      await previewAndCommit(opened, 0.4);
      await settled(h, activityId);
      cards.push(opened);
    }
    expect(h.workers.live).toBe(4);
    const outcome = await Promise.race([
      h.adapter.prepare(requestFor({ activityId: 'act-quadratic-3' }), { operationId: op('prepare-third') }).then(result => (result.ok ? 'prepared' : `failed ${JSON.stringify(result.diagnostics)}`)),
      new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 3000)),
    ]);
    expect(outcome).toBe('prepared');
    // Both earlier cards stay active (nothing was suspended); at most the budget's workers are live.
    for (const card of cards) expect(card.learner.getProjection().status.ui).not.toBe('paused');
    expect(h.workers.live).toBeLessThanOrEqual(4);
    // Each earlier card can still preview: a reclaimed scratch worker is leased again for the next gesture.
    for (const card of cards) {
      await previewAndCommit(card, 0.6);
      expect(card.learner.getProjection().frame?.kind).toBe('committed');
    }
    expect(h.workers.live).toBeLessThanOrEqual(4);
  });
});
