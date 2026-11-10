
const { chromium } = require('playwright');
const fs = require('node:fs');

const SITE_URL =
  'https://molab.marimo.io/notebooks/nb_wCrXdw7BuWwmmVTDna76EL';

const INTERVAL = 5 * 60 * 1000;
const DURATION = 345 * 60 * 1000;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function clickSafeRandom(page) {
  const viewport = page.viewportSize();

  if (!viewport) return false;

  for (let attempt = 0; attempt < 30; attempt++) {
    const x = Math.floor(viewport.width * (0.2 + Math.random() * 0.6));
    const y = Math.floor(viewport.height * (0.2 + Math.random() * 0.6));

    const safe = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);

      if (!element) return false;

      const forbidden = [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'iframe',
        'canvas',
        '[role="button"]',
        '[role="link"]',
        '[contenteditable="true"]',
        '.cm-editor',
        '.monaco-editor',
        '.CodeMirror',
        '.jp-Cell',
        '.marimo-cell-editor',
        '[data-testid*="cell"]'
      ].join(',');

      return !element.closest(forbidden);
    }, { x, y });

    if (safe) {
      await page.mouse.click(x, y);
      console.log(`Random click: x=${x}, y=${y}`);
      return true;
    }
  }

  console.log('No safe blank position found; skipping click.');
  return false;
}

async function findNotebookEditor(page, timeout = 30000) {
  const selectors = [
    '.cm-editor .cm-content',
    '.cm-content[contenteditable="true"]',
    '.monaco-editor [contenteditable="true"]',
    '.CodeMirror textarea',
    '[data-testid="notebook-cell"] [contenteditable="true"]'
  ];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await page.waitForTimeout(1000);
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const excerpt = bodyText.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const buttons = await page.getByRole('button').allTextContents().catch(() => []);
  throw new Error(
    `Notebook editor did not appear. URL: ${page.url()} | ` +
    `Title: ${await page.title().catch(() => 'unavailable')} | ` +
    `Buttons: ${buttons.map(text => text.trim()).filter(Boolean).join(' | ') || '(none)'} | ` +
    `Visible page text: ${excerpt || '(empty)'}`
  );
}

async function startReadOnlyPreview(page) {
  const previewNotice = page.getByText(/read-only preview/i).first();
  if (!(await previewNotice.isVisible().catch(() => false))) return false;

  console.log('Read-only preview detected. Starting notebook on Molab server...');

  const runNow = page.getByRole('button', { name: /^run it now$/i });
  await runNow.waitFor({ state: 'visible', timeout: 15000 });
  await runNow.click();
  await saveScreenshot(page, 'server-confirmation');

  const runOnServer = page.getByRole('button', { name: /^run on server$/i });
  await runOnServer.waitFor({ state: 'visible', timeout: 30000 });
  console.log('Server confirmation dialog is open. Confirming run on server.');
  await runOnServer.click();

  await page.waitForTimeout(5000);
  await saveScreenshot(page, 'server-started');
  console.log('Notebook run on server was started.');
  return true;
}

async function prepareVisualReview(page) {
  const previewNotice = page.getByText(/read-only preview/i).first();
  if (!(await previewNotice.isVisible().catch(() => false))) {
    console.log('Read-only preview message was not visible for review.');
    return;
  }

  const runNow = page.getByRole('button', { name: /^run it now$/i });
  await runNow.waitFor({ state: 'visible', timeout: 15000 });
  await runNow.click();
  await page.getByRole('button', { name: /^run on server$/i })
    .waitFor({ state: 'visible', timeout: 30000 });
  await saveScreenshot(page, 'server-confirmation');
  console.log('Visual review complete; server execution was not started in this review pass.');
}

async function restartIfReconnected(page) {
  const restartButtons = page.locator('[data-testid="restart-session-button"]:visible');
  const restartAppeared = await restartButtons.first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (!restartAppeared) {
    const matchCount = await page.getByTestId('restart-session-button').count().catch(() => 0);
    console.log(`Blue Restart link did not become visible (${matchCount} matching elements). Skipping restart.`);
    return false;
  }

  const restart = restartButtons.first();
  console.log('Blue Restart link found. Taking a screenshot before clicking...');
  await saveScreenshot(page, 'restart-banner');
  console.log('Clicking the blue Restart link...');
  await restart.click();

  const confirmRestart = page.getByRole('button', { name: 'Confirm Restart' });
  await confirmRestart.waitFor({ state: 'visible', timeout: 10000 });
  await saveScreenshot(page, 'restart-confirmation');
  console.log('Confirm Restart button found. Clicking it...');
  await confirmRestart.click();
  console.log('Restart confirmed. Waiting for the notebook session...');
  await page.waitForTimeout(15000);
  await saveScreenshot(page, 'restart-complete');

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const sessionError = /session.{0,80}(error|failed|expired|invalid|unavailable|closed|ended|not found|disconnected|could not|unable)|(?:error|failed|expired|invalid|not found|disconnected|could not|unable).{0,80}session/i;

  if (sessionError.test(bodyText)) {
    console.log('Session error detected after restart. Reloading the notebook once...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    await saveScreenshot(page, 'session-refreshed');
  }

  return true;
}

async function takeOverIfReader(page) {
  const takeoverByTestId = page.getByTestId('takeover-button');
  const takeoverByRole = page.getByRole('button', { name: /take over/i }).first();
  const takeover = await takeoverByTestId.isVisible().catch(() => false)
    ? takeoverByTestId
    : takeoverByRole;

  if (!(await takeover.isVisible().catch(() => false))) {
    console.log('Reader-mode Take over button is not visible.');
    return false;
  }

  console.log('Reader mode detected. Clicking Take over...');
  await takeover.click();
  const reconnectBanner = page.getByText(/you have reconnected to an existing session/i).first();
  const bannerAppeared = await reconnectBanner
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  console.log(bannerAppeared
    ? 'Reconnection banner appeared after Take over.'
    : 'No reconnection banner appeared after Take over.');
  await saveScreenshot(page, 'after-takeover');
  return true;
}

async function saveScreenshot(page, name) {
  const path = `artifacts/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`Screenshot saved: ${path}`);
}

async function main() {
  fs.mkdirSync('artifacts', { recursive: true });

  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    storageState: 'auth.json',
    viewport: { width: 1365, height: 900 }
  });

  const page = await context.newPage();

  page.on('pageerror', error => {
    console.error(`[browser page error] ${error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      console.error(`[browser console error] ${message.text()}`);
    }
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    console.error(
      `[request failed] ${url.origin}${url.pathname} | ` +
      `${request.failure()?.errorText || 'unknown error'}`
    );
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      console.error(`[HTTP ${response.status()}] ${url.origin}${url.pathname}`);
    }
  });

  try {
    console.log('Opening Molab...');

    await page.goto(SITE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(5000);
    await saveScreenshot(page, 'notebook-opened');

    await takeOverIfReader(page);

    if (process.argv.includes('--visual-review')) {
      await prepareVisualReview(page);
      return;
    }

    await restartIfReconnected(page);

    // A stopped sandbox has no editor until it is relaunched.
    await recoverNotebook(page);

    // Read-only previews execute from the server confirmation dialog and have no editor.
    const previewStarted = await startReadOnlyPreview(page);

    // Step 2: Run exactly once

    if (!previewStarted) {
      console.log('Preparing notebook execution...');

      // Focus the notebook editor
      const editor = await findNotebookEditor(page, 20000);

      await editor.click();

      // Run all stale cells once
      await page.keyboard.press('Control+Shift+R');

      console.log('Run all shortcut sent successfully.');


      console.log('Notebook Run clicked once.');
    }

    // Step 3: Periodic safe clicks
    const endTime = Date.now() + DURATION;

    while (Date.now() < endTime) {
      await sleep(INTERVAL);

      if (page.isClosed()) {
        throw new Error('Notebook page was closed.');
      }

      await clickSafeRandom(page);
    }

    console.log('Session duration completed.');

  } catch (error) {
    console.error('Automation error:', error);
    await saveScreenshot(page, 'error').catch(screenshotError => {
      console.error('Could not save error screenshot:', screenshotError.message);
    });
    process.exitCode = 1;

  } finally {
    await context.close();
    await browser.close();
  }
}

async function recoverNotebook(page) {
    const stopped = page.getByText(/notebook stopped/i).first();

    if (!(await stopped.isVisible().catch(() => false))) {
        console.log('Notebook is not stopped.');
        return false;
    }

    console.log('Stopped sandbox detected.');

    const relaunch = page.getByRole('button', {
        name: /^relaunch$/i
    });

    await relaunch.waitFor({ state: 'visible', timeout: 15000 });

    await relaunch.click();

    console.log('Relaunch clicked.');

    // Let the app rebuild the notebook in place. Reloading here can interrupt it.
    await page.waitForTimeout(15000);
    await findNotebookEditor(page, 60000);
    console.log('Notebook editor is available after relaunch.');

    return true;
}


main();
