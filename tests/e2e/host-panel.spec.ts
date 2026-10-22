import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/host/conversations/*/art/*.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#183039"/></svg>' }));
});

const conversationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-10-22T00:00:00.000Z';

function conversation() {
  return { conversation_id: conversationId, locale: 'en', session_id: null, paused: false, created_at: createdAt };
}

test('local host UI polls a pending story and waits for an explicit player choice', async ({ page }) => {
  // A LAN HTTP origin has getRandomValues but no secure-context randomUUID or microphone.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    localStorage.setItem('rpg-night.v2.conversationId', '11111111-1111-4111-8111-111111111111');
    localStorage.setItem('rpg-night.v2.conversationLocale', 'en');
    localStorage.setItem('rpg-night.v2.sessionId', '99999999-9999-4999-8999-999999999999');
  });
  const playerTurns: string[] = [];
  let operationPolls = 0;
  await page.route(`**/api/host/conversations/${conversationId}`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ kind: 'error', code: 'NOT_FOUND', message: 'Missing saved conversation.', retryable: false }),
  }));

  await page.route('**/api/host/conversations', route => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'message', conversation: conversation(), assistant_text: 'What kind of adventure would you like?' }),
  }));

  await page.route('**/api/host/conversations/*/turns', async route => {
    const input = route.request().postDataJSON() as { text: string; request_id: string };
    expect(input.request_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    playerTurns.push(input.text);
    if (playerTurns.length === 1) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ kind: 'message', conversation: conversation(), assistant_text: 'Choose one of these stories.' }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ kind: 'operation', conversation: conversation(), operation: {
        operation_id: operationId, kind: 'prepare_adventure', status: 'pending', created_at: createdAt,
        expires_at: '2026-10-22T00:05:00.000Z',
      } }),
    });
  });

  await page.route('**/api/host/conversations/*/operation', async route => {
    operationPolls++;
    const operation = operationPolls === 1
      ? { operation_id: operationId, kind: 'prepare_adventure', status: 'pending', created_at: createdAt, expires_at: '2026-10-22T00:05:00.000Z' }
      : { operation_id: operationId, kind: 'prepare_adventure', status: 'ready', created_at: createdAt, completed_at: '2026-10-22T00:00:02.000Z', result: { kind: 'adventure', adventure_id: 'rain-still-lighthouse', title: 'The Rain-Still Lighthouse' } };
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ kind: 'operation', conversation: conversation(), operation }),
    });
  });

  await page.goto('/');
  await page.locator('#host-mode-btn').click();
  await expect(page.locator('#host-transcript')).toContainText('Choose one of these stories.');
  await expect(page.locator('.skip-link')).toHaveAttribute('href', '#host-main');
  await expect(page.locator('#host-transcript')).toContainText('previous conversation is not on this server');
  await expect(page.locator('#host-mic-btn')).toBeDisabled();
  await expect(page.locator('#host-mic-note')).toContainText('HTTPS or localhost');

  const input = page.locator('#host-input');
  await input.fill('Prepare a cozy mystery about a lighthouse.');
  await page.locator('#host-send-btn').click();
  await expect(input).toBeDisabled();
  await expect(page.locator('#host-transcript')).toContainText('The Rain-Still Lighthouse');
  await expect(input).toBeEnabled();

  expect(operationPolls).toBeGreaterThanOrEqual(2);
  expect(playerTurns).toHaveLength(2);
  expect(playerTurns[1]).toContain('lighthouse');
});

test('clicking a host choice sends its visible ordinal through the conversational route', async ({ page }) => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const playerTurns: string[] = [];
  const activeConversation = { ...conversation(), session_id: sessionId };
  const turn = (revision: number) => ({
    schema_version: 2, session_id: sessionId, locale: 'en', revision, view_revision: revision,
    phase: 'awaiting_choice', scene_id: 'lighthouse', narration: revision === 1
      ? 'Two lanterns shine across the water.'
      : 'The blue light guides the party to the shore.',
    choices: [
      { id: 'red-light', label: 'Follow the red lantern' },
      { id: 'blue-light', label: 'Follow the blue lantern' },
    ], affordances: [], pending_check: null, recent_outcome: null, inventory: [], recap: '',
    next_expected_input: 'Choose an option.', visual_status: 'ready',
  });

  await page.route('**/api/host/conversations', route => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ kind: 'message', conversation: conversation(), assistant_text: 'Welcome.' }),
  }));
  await page.route('**/api/host/conversations/*/turns', async route => {
    const input = route.request().postDataJSON() as { text: string };
    playerTurns.push(input.text);
    const body = playerTurns.length < 2
      ? { kind: 'message', conversation: conversation(), assistant_text: 'Choose a story.' }
      : playerTurns.length === 2
        ? { kind: 'turn', conversation: activeConversation, turn: turn(1), assistant_text: turn(1).narration }
        : playerTurns.length === 3
          ? { kind: 'turn', conversation: activeConversation, turn: { ...turn(2), phase: 'awaiting_check', choices: [], pending_check: { id: 'cross-water', kind: 'd20', difficulty_class: 11, prompt: 'Keep your footing across the water.' } }, assistant_text: 'Roll the d20 when ready.' }
          : { kind: 'turn', conversation: activeConversation, turn: { ...turn(3), recent_outcome: { kind: 'check', check_id: 'cross-water', sides: 20, total: 17, difficulty_class: 11, result: 'success', summary: 'The group crosses safely.' } }, assistant_text: 'The blue light guides the party to the shore.' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/');
  await page.locator('#host-mode-btn').click();
  await expect(page.locator('#host-transcript')).toContainText('Choose a story.');
  await page.locator('#host-input').fill('We choose the lighthouse adventure for Ada and Bo.');
  await page.locator('#host-send-btn').click();
  await expect(page.locator('.host-choice')).toHaveCount(2);
  await page.locator('.host-choice').nth(1).click();
  await expect(page.locator('#host-roll-btn')).toBeVisible();
  await page.locator('#host-roll-btn').click();
  await expect(page.locator('#host-narration')).toContainText('The blue light guides');
  await expect(page.locator('#host-outcome')).toContainText('17 / DC 11');
  await expect(page.locator('#host-roll-btn')).toBeHidden();
  expect(playerTurns).toHaveLength(4);
  expect(playerTurns[2]).toBe('We choose option 2: Follow the blue lantern');
  expect(playerTurns[3]).toBe('Roll the d20.');
});

test('host shared-screen URL renders public turns and links the v2 comic export', async ({ page }) => {
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const turn = (revision: number) => ({
    schema_version: 2, session_id: sessionId, locale: 'es', revision, view_revision: revision,
    phase: 'awaiting_choice', scene_id: revision === 1 ? 'shore' : 'lighthouse',
    narration: revision === 1 ? 'La marea rodea el faro.' : 'La luz azul guía al grupo hasta la orilla.',
    choices: [{ id: 'seguir-luz', label: 'Seguir la luz azul' }], affordances: [], pending_check: null,
    recent_outcome: revision === 1 ? null : { kind: 'action', action_label: 'Seguir la luz azul', summary: 'La ruta queda iluminada.' },
    inventory: [{ id: 'llave', name: 'Llave de latón', description: 'Una llave pequeña.' }], recap: '',
    next_expected_input: 'Elige una opción.', visual_status: 'ready',
  });
  const state = {
    conversation_id: conversationId, locale: 'es', session_id: sessionId, paused: false,
    turn: turn(2), turns: [turn(1), turn(2)],
  };
  await page.route(`**/api/host/conversations/${conversationId}/tv`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(state),
  }));
  await page.route(`**/api/host/conversations/${conversationId}/events`, route => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: `event: public-state\ndata: ${JSON.stringify(state)}\n\n`,
  }));

  await page.goto(`/?host=${conversationId}`);
  await expect(page.locator('#host-tv')).toBeVisible();
  await expect(page.locator('.skip-link')).toHaveAttribute('href', '#host-tv-main');
  await expect(page.locator('#host-tv-title')).toHaveText('Vuestra historia, juntos');
  await expect(page.locator('#host-tv-narration')).toContainText('La luz azul guía');
  await expect(page.locator('#host-tv-panels .host-tv-panel')).toHaveCount(2);
  await expect(page.locator('#host-tv-inventory')).toContainText('Llave de latón');
  await expect(page.locator('#host-tv-comic')).toHaveAttribute('href', `/api/host/conversations/${conversationId}/comic.svg`);
  await expect(page.locator('#host-tv-comic')).toHaveText('Descargar SVG');
  await expect(page.locator('#host-tv-png')).toBeEnabled();
  await expect(page.locator('#host-tv-png')).toHaveText('Descargar PNG');
  await expect(page.locator('#host-tv-art-image')).toHaveJSProperty('naturalWidth', 1600);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('#app')).toBeHidden();
});

test('a stale controller restores the current turn before another action and never repeats the rejected action', async ({ page }) => {
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const activeConversation = { ...conversation(), session_id: sessionId };
  const turn = (revision: number) => ({
    schema_version: 2, session_id: sessionId, locale: 'en', revision, view_revision: revision,
    phase: 'awaiting_choice', scene_id: `scene-${revision}`, narration: `Public scene ${revision}.`,
    choices: [{ id: 'continue', label: 'Continue together' }], affordances: [], pending_check: null,
    recent_outcome: null, inventory: [], recap: '', next_expected_input: 'Choose.', visual_status: 'ready',
  });
  const revisions: number[] = [];
  let obsoleteOperationPolls = 0;
  await page.route(`**/api/host/conversations/${conversationId}`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ kind: 'turn', conversation: activeConversation, turn: turn(3), assistant_text: turn(3).narration }),
  }));
  await page.route('**/api/host/conversations/*/operation', route => {
    obsoleteOperationPolls++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ kind: 'operation', conversation: activeConversation, operation: { operation_id: operationId, kind: 'prepare_adventure', status: 'ready', created_at: createdAt, completed_at: createdAt, result: { kind: 'adventure', adventure_id: 'old-story', title: 'Ghost ready story' } } }) });
  });
  await page.route('**/api/host/conversations', route => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ kind: 'turn', conversation: activeConversation, turn: turn(1), assistant_text: turn(1).narration }),
  }));
  await page.route('**/api/host/conversations/*/tv', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, locale: 'en', session_id: sessionId, paused: false, turn: turn(2), turns: [turn(1), turn(2)] }),
  }));
  await page.route('**/api/host/conversations/*/turns', route => {
    revisions.push((route.request().postDataJSON() as { expected_revision: number }).expected_revision);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(revisions.length === 1
      ? { kind: 'error', code: 'REVISION_CONFLICT', message: 'The story moved on another screen.', retryable: true, current_revision: 2 }
      : { kind: 'turn', conversation: activeConversation, turn: turn(3), assistant_text: turn(3).narration }) });
  });
  await page.goto('/');
  await page.locator('#host-mode-btn').click();
  await expect(page.locator('#host-narration')).toHaveText('Public scene 1.');
  await page.locator('.host-choice').click();
  await expect(page.locator('#host-narration')).toHaveText('Public scene 2.');
  await expect(page.locator('#host-error')).toContainText('latest chapter is ready');
  expect(revisions).toEqual([1]);
  await page.locator('.host-choice').click();
  await expect(page.locator('#host-narration')).toHaveText('Public scene 3.');
  expect(revisions).toEqual([1, 2]);
  await page.reload();
  await page.locator('#host-mode-btn').click();
  await expect(page.locator('#host-narration')).toHaveText('Public scene 3.');
  await expect(page.locator('#host-transcript')).not.toContainText('Ghost ready story');
  expect(obsoleteOperationPolls).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
