import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Spanish adventure, second TV, persistence and comic exports work in the production app', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#landing')).toBeVisible();
  await page.locator('#landing [data-lang="es"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.locator('#players-input').fill('Ana, Luis'); await page.locator('#begin-btn').click();
  await expect(page.locator('#scene-title')).toHaveText('El bosque escucha');
  await expect(page).toHaveURL(/session=[a-f0-9-]{36}/);
  const shareUrl = page.url();
  const tv = await context.newPage(); await tv.goto(shareUrl);
  await expect(tv.locator('#scene-title')).toHaveText('El bosque escucha');
  await page.locator('#dice-btn').click(); await expect(page.locator('#roll-display')).not.toBeEmpty();
  await page.locator('#choices button').nth(1).click();
  await expect(page.locator('#scene-title')).toHaveText('El puente de los nombres olvidados');
  await expect(tv.locator('#scene-title')).toHaveText('El puente de los nombres olvidados');
  await page.reload(); await expect(page.locator('#scene-title')).toHaveText('El puente de los nombres olvidados');
  await page.locator('#action-input').fill('Ayudamos al caballero a recordar su nombre'); await page.locator('#action-btn').click();
  await expect(page.locator('#scene-title')).toHaveText('Un mercado bajo la luna');
  for (let chapter = 3; chapter <= 5; chapter++) {
    const response = page.waitForResponse(r => r.url().includes('/actions') && r.request().method() === 'POST');
    await page.locator('#choices button').first().click(); await response;
    await expect(page.locator('#busy')).toBeHidden();
  }
  await expect(page.locator('#view-comic')).toBeVisible();
  await expect(page.locator('#comic-grid img')).toHaveCount(6);
  const pngEvent = page.waitForEvent('download'); await page.locator('#download-png').click();
  const png = await pngEvent; expect(png.suggestedFilename()).toMatch(/\.png$/);
  expect(await png.failure()).toBeNull(); const pngPath = await png.path(); expect(pngPath).toBeTruthy();
  expect((await readFile(pngPath!)).subarray(1, 4).toString()).toBe('PNG');
  const svgEvent = page.waitForEvent('download'); await page.locator('#download-svg').click();
  const svg = await svgEvent; expect(svg.suggestedFilename()).toMatch(/\.svg$/); expect(await svg.failure()).toBeNull();
  await page.emulateMedia({ media: 'print' }); const pdf = await page.pdf({ format: 'A4', printBackground: true });
  expect(pdf.length).toBeGreaterThan(10000); expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#new-adventure-btn').click(); await expect(page.locator('#landing')).toBeVisible();
  await page.goto(shareUrl); await expect(page.locator('#comic-grid img')).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('mobile layout, input validation, early ending and literal player names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#players-input').fill(''); await page.locator('#begin-btn').click();
  await expect(page.locator('#landing')).toBeVisible();
  await page.locator('#players-input').fill('<b>Sam</b>');
  await page.locator('.world-card').filter({ has: page.locator('[value="mystery"]') }).click();
  await page.locator('#begin-btn').click(); await expect(page.locator('#scene-title')).toHaveText('A room that does not exist');
  await expect(page.locator('#players-list')).toHaveText('<b>Sam</b>'); expect(await page.locator('#players-list b').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#end-btn').click(); await expect(page.locator('#end-dialog')).toBeVisible();
  await page.locator('#end-dialog button[value="confirm"]').click();
  await expect(page.locator('#view-comic')).toBeVisible(); await expect(page.locator('#comic-grid img')).toHaveCount(2);
});

test('a delayed action response cannot replace a newer TV update', async ({ page, context }) => {
  await page.goto('/'); await page.locator('#begin-btn').click(); await expect(page.locator('#scene-title')).toHaveText('The forest is listening');
  const tv = await context.newPage(); await tv.goto(page.url());
  await expect(tv.locator('#scene-title')).toHaveText('The forest is listening');
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/actions', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await page.locator('#choices button').first().click();
  await expect(tv.locator('#scene-title')).toHaveText('The bridge of forgotten names');
  await tv.locator('#choices button').first().click();
  await expect(page.locator('#scene-title')).toHaveText('A market under the moon');
  release(); await expect(page.locator('#busy')).toBeHidden(); await expect(page.locator('#scene-title')).toHaveText('A market under the moon');
});

test('voice choices use the dice and narration can be muted and enabled again', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { webkitSpeechRecognition: unknown; speechSynthesis: unknown; SpeechSynthesisUtterance: unknown; speechCount: number };
    w.speechCount = 0;
    class Recognition {
      onresult: ((event: unknown) => void) | null = null; onend: (() => void) | null = null;
      start() { setTimeout(() => { this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Option two.' } }] }); this.onend?.(); }, 30); }
      stop() {} abort() {}
    }
    w.webkitSpeechRecognition = Recognition;
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { cancel() {}, speak() { w.speechCount++; } } });
    w.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });
  await page.goto('/'); await page.locator('#begin-btn').click(); await expect(page.locator('#scene-title')).toHaveText('The forest is listening');
  await page.locator('#tts-btn').click(); await expect.poll(() => page.evaluate(() => (window as unknown as { speechCount: number }).speechCount)).toBe(1);
  await page.locator('#dice-btn').click(); expect(await page.evaluate(() => (window as unknown as { speechCount: number }).speechCount)).toBe(1);
  await page.locator('#tts-btn').click(); await page.locator('#tts-btn').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { speechCount: number }).speechCount)).toBe(2);
  await page.locator('#mic-btn').click(); await expect(page.locator('#scene-title')).toHaveText('The bridge of forgotten names');
  await expect(page.locator('#roll-display')).toContainText('used'); await expect(page.locator('#comic-grid')).toContainText('Cross the broken bridge');
});
