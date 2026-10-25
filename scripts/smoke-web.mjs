/**
 * Real-browser smoke for dsh-dsweb.
 *
 * Boot `dsh web` yourself, then pass its tokenized URL:
 *   DSH_WEB_URL='http://127.0.0.1:18787/?token=…' pnpm smoke:web
 *
 * Checks: the client bundle applied its Chat/Work switch, the panel opens, the
 * host /dsh-dsb/state route answers 200, and the page logs no errors.
 * `DSH_SMOKE_SCREENSHOT=/tmp/chat.png` saves the panel for a visual look.
 */
import { chromium } from 'playwright';

const url = process.env.DSH_WEB_URL;
if (!url) {
  console.error('set DSH_WEB_URL to the tokenized dsh web URL');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const stateStatuses = [];

page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  if (new URL(response.url()).pathname === '/dsh-dsb/state') stateStatuses.push(response.status());
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('button.dswc-seg-btn').first().waitFor({ timeout: 20000 });

  // DSH's own first-run dialogs cover the sidebar; close whatever is open.
  // They can mount a beat after the shell, so keep looking for a short while.
  for (let i = 0; i < 6; i += 1) {
    const close = page.locator('[role="dialog"] [aria-label="Close"]').first();
    if (await close.isVisible().catch(() => false)) {
      await close.click();
      await page.waitForTimeout(200);
    } else {
      await page.waitForTimeout(300);
    }
  }

  const chat = page.locator('[aria-label="Chat"], [aria-label="聊天"]').first();
  await chat.waitFor({ timeout: 10000 });
  for (let i = 0; i < 3; i += 1) {
    try {
      await chat.click({ timeout: 3000 });
      break;
    } catch (error) {
      const close = page.locator('[role="dialog"] [aria-label="Close"]').first();
      if (!(await close.isVisible().catch(() => false))) throw error;
      await close.click();
    }
  }
  await page.locator('.dswc-setup, .dswc-composer').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);

  if (!stateStatuses.includes(200)) {
    throw new Error(`/dsh-dsb/state never answered 200 (saw ${JSON.stringify(stateStatuses)})`);
  }
  if (errors.length > 0) throw new Error(`console errors:\n${errors.join('\n')}`);

  if (process.env.DSH_SMOKE_SCREENSHOT) {
    await page.screenshot({ path: process.env.DSH_SMOKE_SCREENSHOT, fullPage: true });
  }
  console.log('smoke ok: switch, panel, /dsh-dsb/state 200, no console errors');
} finally {
  await browser.close();
}
