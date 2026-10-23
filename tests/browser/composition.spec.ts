import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { VisualizationSession, MutationGuard } from '@experiment-kit/core/declarative';
import type { VisualizationTools } from '@experiment-kit/agent';
interface Studio { session: VisualizationSession; tools: VisualizationTools; guard(): MutationGuard }
async function open(page: Page) { await page.goto('/agent.html'); await page.waitForFunction(() => Boolean((window as unknown as {__COMPOSITION_STUDIO__?: Studio}).__COMPOSITION_STUDIO__)); }
async function state(page: Page) { return page.evaluate(() => (window as unknown as {__COMPOSITION_STUDIO__: Studio}).__COMPOSITION_STUDIO__.session.getState()); }
async function preset(page: Page, id: string) { await page.getByRole('combobox').selectOption(id); await expect(page.getByRole('status').first()).toContainText('Editable composition loaded'); }

test('public home opens the studio and preserves the gallery, guide, and existing experiment links', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as {__COMPOSITION_STUDIO__?: Studio}).__COMPOSITION_STUDIO__));
  await expect(page).toHaveTitle(/Explorable Models.*Composition Studio/);
  await expect(page.getByText('The revision demo is scripted.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Preview guide', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Embed an explanation' })).toBeVisible();
  await page.goto('/gallery.html');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Same ramp. Different motion.');
  await page.goto('/?experiment=linear-map&embed=1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('See what a matrix does.');
  await expect(page.locator('.app')).toHaveClass(/embedded/);
});

test('composition studio binds all presets and exact projectile endpoint to worker frames', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await open(page);
  await expect(page).toHaveTitle(/Composition Studio/); expect((await state(page)).frame?.quantities.ordinate.value).toBe(2);
  await preset(page, 'triangle'); const triangle=(await state(page)).frame!; expect(triangle.quantities.area.value).toBe(6); expect(triangle.quantities.sideBC.value).toBe(5);
  await preset(page, 'projectile');
  await page.evaluate(async () => { const {session,guard}=(window as unknown as {__COMPOSITION_STUDIO__: Studio}).__COMPOSITION_STUDIO__; await session.seek(5,guard()); });
  const end=(await state(page)).frame!; expect(end.time).toBe(0.8); expect(end.terminal).toBe(true); expect(end.quantities.range.value).toBeCloseTo(2.4); expect(end.quantities.verticalVelocity.value).toBe(-4);
  for(const id of ['linear-map','riemann-sums','oscillator','supplied-data','probability']) { await preset(page,id); expect((await state(page)).status).toBe('ready'); }
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('tool-only focused edits preserve first curve, guard human changes, and reopen exact state', async ({ page }) => {
  await open(page);
  const outcome=await page.evaluate(async()=>{
    const {session,tools,guard}=(window as unknown as {__COMPOSITION_STUDIO__: Studio}).__COMPOSITION_STUDIO__;
    const before=session.getState();
    const prepared=await tools.execute('visualization_revise',{edits:[{op:'set',collection:'series',id:'cosine',value:{label:'Cosine comparison',x:'x',y:'amplitude*cos(2*pi*frequency*x)',domain:[-2,2],samples:101}},{op:'setMark',viewId:'plot',mark:{id:'cosine',type:'line',label:'Cosine comparison',series:'cosine',style:{stroke:'#aa5533',dash:'dashed'}}},{op:'setMark',viewId:'plot',mark:{id:'annotation',type:'label',label:'Exact probe',text:'Exact probe',bindings:{position:'probePoint'},offset:[12,-14]}}],guard:guard()});
    if(!prepared.ok)throw new Error(JSON.stringify(prepared));
    const committed=await tools.execute('visualization_commit',{candidateId:(prepared.data as {candidateId:string}).candidateId,guard:guard()});if(!committed.ok)throw new Error(JSON.stringify(committed));
    const firstPreserved=before.document!.series!.wave.y===session.getState().document!.series!.wave.y;
    const stale=guard();await session.setParameters({amplitude:3},guard());
    const conflict=await tools.execute('visualization_operate',{action:'parameters',parameters:{amplitude:4},guard:stale});
    const active=session.getState(); const invalid=await tools.execute('visualization_revise',{edits:[{op:'set',collection:'quantities',id:'bad',value:{expression:'missingQuantity+1'}}],guard:guard()});
    const preserved=active.run!.id===session.getState().run!.id;
    const artifact=session.exportDocument();await session.setParameters({amplitude:1},guard());await session.restoreDocument(artifact,guard());
    return {firstPreserved,conflict,invalid,preserved,value:session.getState().frame!.quantities.ordinate.value,identity:session.getState().identity,expected:artifact.identity,comparisons:artifact.comparisons.length};
  });
  expect(outcome.firstPreserved).toBe(true);expect(outcome.conflict.ok).toBe(false);expect(outcome.invalid.ok).toBe(false);expect(outcome.preserved).toBe(true);expect(outcome.value).toBe(3);expect(outcome.identity).toEqual(outcome.expected);expect(outcome.comparisons).toBeGreaterThan(0);
  await expect(page.locator('svg text').filter({hasText:'Exact probe'})).toBeVisible();
});

test('presentation revision preserves time and exact input handles undefined and small errors', async ({page})=>{
  await open(page);await preset(page,'oscillator');await page.evaluate(async()=>{const s=(window as unknown as {__COMPOSITION_STUDIO__:Studio}).__COMPOSITION_STUDIO__;await s.session.seek(2,s.guard());});
  const before=await state(page);await page.getByRole('button',{name:'Try a targeted revision'}).click();await expect(page.getByRole('status').first()).toContainText('scientific run and time preserved');const after=await state(page);expect(after.run?.id).toBe(before.run?.id);expect(after.frame?.time).toBe(2);expect(after.identity?.documentRevision).not.toBe(before.identity?.documentRevision);
  await preset(page,'triangle');await page.getByRole('textbox',{name:'Base x exact value'}).fill('0');await page.getByRole('button',{name:'Apply Base x',exact:true}).click();await expect.poll(async()=>(await state(page)).frame?.quantities.angleA.status).toBe('undefined');await expect(page.locator('.ek-values')).toContainText(/undefined/i);
  await preset(page,'riemann-sums');await expect(page.locator('.ek-values')).toContainText(/8\.333/);expect((await state(page)).frame?.quantities.error.value).not.toBe(0);
});

test('responsive compositions expose keyboard controls without serious automated accessibility findings', async ({page})=>{
  await open(page);await page.getByRole('slider',{name:'Amplitude',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect.poll(async()=>(await state(page)).run?.params.amplitude).toBeCloseTo(2.1);
  const results=await new AxeBuilder({page}).analyze();expect(results.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
  for(const width of [1440,1024,390]) {await page.setViewportSize({width,height:900});await expect(page.getByRole('textbox',{name:'Amplitude exact value'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:`/tmp/experiment-kit-composition-${width}.png`,fullPage:true});}
  await preset(page,'triangle');await page.getByRole('textbox',{name:'Base x exact value'}).fill('0');await page.getByRole('button',{name:'Apply Base x',exact:true}).click();await expect.poll(async()=>(await state(page)).frame?.quantities.angleA.status).toBe('undefined');await page.screenshot({path:'/tmp/experiment-kit-composition-boundary-390.png',fullPage:true});
});
