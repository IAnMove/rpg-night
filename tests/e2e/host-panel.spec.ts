import { expect, test } from '@playwright/test';

const conversationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-10-22T00:00:00.000Z';

function conversation() {
  return { conversation_id: conversationId, locale: 'en', session_id: null, paused: false, created_at: createdAt };
}

test('local host UI polls a pending story and waits for an explicit player choice', async ({ page }) => {
  const playerTurns: string[] = [];
  let operationPolls = 0;

  await page.route('**/api/host/conversations', route => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'message', conversation: conversation(), assistant_text: 'What kind of adventure would you like?' }),
  }));

  await page.route('**/api/host/conversations/*/turns', async route => {
    const input = route.request().postDataJSON() as { text: string };
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
        : { kind: 'turn', conversation: activeConversation, turn: turn(2), assistant_text: 'The blue light guides the party to the shore.' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/');
  await page.locator('#host-mode-btn').click();
  await expect(page.locator('#host-transcript')).toContainText('Choose a story.');
  await page.locator('#host-input').fill('We choose the lighthouse adventure for Ada and Bo.');
  await page.locator('#host-send-btn').click();
  await expect(page.locator('.host-choice')).toHaveCount(2);
  await page.locator('.host-choice').nth(1).click();
  await expect(page.locator('#host-narration')).toContainText('The blue light guides');
  expect(playerTurns).toHaveLength(3);
  expect(playerTurns[2]).toBe('We choose option 2: Follow the blue lantern');
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
  await expect(page.locator('#host-tv-title')).toHaveText('Vuestra historia, juntos');
  await expect(page.locator('#host-tv-narration')).toContainText('La luz azul guía');
  await expect(page.locator('#host-tv-panels .host-tv-panel')).toHaveCount(2);
  await expect(page.locator('#host-tv-inventory')).toContainText('Llave de latón');
  await expect(page.locator('#host-tv-comic')).toHaveAttribute('href', `/api/host/conversations/${conversationId}/comic.svg`);
  await expect(page.locator('#app')).toBeHidden();
});
