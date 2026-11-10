
const { chromium } = require('playwright');
const fs = require('node:fs');

const SITE_URL =
  'https://molab.marimo.io/notebooks/nb_wCrXdw7BuWwmmVTDna76EL';

const INTERVAL = 5 * 60 * 1000;
const DURATION = 345 * 60 * 1000;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function safeUrlForLog(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const safePath = url.pathname.replace(/\/session\/[^/]+/i, '/session/[redacted]');
    return `${url.origin}${safePath}`;
  } catch {
    return '[unparseable URL]';
  }
}

async function findVisibleAcrossFrames(page, locatorFactory, timeout = 0) {
  const deadline = Date.now() + timeout;

  do {
    for (const frame of page.frames()) {
      const candidates = locatorFactory(frame);
      const count = await candidates.count().catch(() => 0);

      for (let index = 0; index < count; index++) {
        const locator = candidates.nth(index);
        if (await locator.isVisible().catch(() => false)) {
          if (frame !== page.mainFrame()) {
            console.log(`Found target in iframe: ${safeUrlForLog(frame.url())}`);
          }
          return { locator, frame };
        }
      }
    }

    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);

  return null;
}

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
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let index = 0; index < count; index++) {
          const editor = candidates.nth(index);
          if (await editor.isVisible().catch(() => false)) {
            if (frame !== page.mainFrame()) {
              console.log(`Found notebook editor in iframe: ${safeUrlForLog(frame.url())}`);
            }
            return editor;
          }
        }
      }
    }
    await page.waitForTimeout(1000);
  }

  const frameDetails = await Promise.all(page.frames().map(async frame => {
    const bodyText = await frame.locator('body').innerText().catch(() => '');
    return `${safeUrlForLog(frame.url())}: ${bodyText.replace(/\s+/g, ' ').trim().slice(0, 700)}`;
  }));
  const buttons = await Promise.all(page.frames().map(frame =>
    frame.getByRole('button').allTextContents().catch(() => [])
  ));
  throw new Error(
    `Notebook editor did not appear. URL: ${page.url()} | ` +
    `Title: ${await page.title().catch(() => 'unavailable')} | ` +
    `Buttons: ${buttons.flat().map(text => text.trim()).filter(Boolean).join(' | ') || '(none)'} | ` +
    `Frames: ${frameDetails.join(' || ') || '(none)'}`
  );
}

async function startReadOnlyPreview(page) {
  const previewNotice = await findVisibleAcrossFrames(
    page,
    frame => frame.getByText(/read-only preview/i),
    0
  );
  if (!previewNotice) return false;

  console.log('Read-only preview detected. Starting notebook on Molab server...');

  const runNow = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run it now$/i }),
    15000
  );
  if (!runNow) throw new Error('Read-only preview appeared, but Run it now was not found.');
  await runNow.locator.click();
  await saveScreenshot(page, 'server-confirmation');

  const runOnServer = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run on server$/i }),
    30000
  );
  if (!runOnServer) throw new Error('Run on server confirmation did not appear.');
  console.log('Server confirmation dialog is open. Confirming run on server.');
  await runOnServer.locator.click();

  await page.waitForTimeout(5000);
  await saveScreenshot(page, 'server-started');
  console.log('Notebook run on server was started.');
  return true;
}

async function prepareVisualReview(page) {
  const previewNotice = await findVisibleAcrossFrames(
    page,
    frame => frame.getByText(/read-only preview/i),
    0
  );
  if (!previewNotice) {
    console.log('Read-only preview message was not visible for review.');
    return;
  }

  const runNow = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run it now$/i }),
    15000
  );
  if (!runNow) throw new Error('Read-only preview appeared, but Run it now was not found.');
  await runNow.locator.click();
  const runOnServer = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run on server$/i }),
    30000
  );
  if (!runOnServer) throw new Error('Run on server confirmation did not appear.');
  await saveScreenshot(page, 'server-confirmation');
  console.log('Visual review complete; server execution was not started in this review pass.');
}

async function restartIfReconnected(page) {
  const restartTarget = await findVisibleAcrossFrames(
    page,
    frame => frame.getByTestId('restart-session-button'),
    10000
  );

  if (!restartTarget) {
    console.log('Blue Restart link was not found in the page or any iframe. Skipping restart.');
    return false;
  }

  console.log('Blue Restart link found. Taking a screenshot before clicking...');
  await saveScreenshot(page, 'restart-banner');
  console.log('Clicking the blue Restart link...');
  await restartTarget.locator.click();

  const confirmTarget = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: 'Confirm Restart' }),
    10000
  );
  if (!confirmTarget) {
    throw new Error('Clicked blue Restart, but Confirm Restart did not appear in the page or any iframe.');
  }
  await saveScreenshot(page, 'restart-confirmation');
  console.log('Confirm Restart button found. Clicking it...');
  await confirmTarget.locator.click();
  console.log('Restart confirmed. Waiting for the notebook session...');
  await page.waitForTimeout(15000);
  await saveScreenshot(page, 'restart-complete');

  const bodyText = (await Promise.all(page.frames().map(frame =>
    frame.locator('body').innerText().catch(() => '')
  ))).join(' ');
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
  const takeoverTarget = await findVisibleAcrossFrames(
    page,
    frame => frame.getByTestId('takeover-button'),
    2000
  ) || await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /take over/i }),
    0
  );

  if (!takeoverTarget) {
    console.log('Reader-mode Take over button is not visible in the page or any iframe.');
    return false;
  }

  console.log('Reader mode detected. Clicking Take over...');
  await takeoverTarget.locator.click();
  const reconnectBanner = await findVisibleAcrossFrames(
    page,
    frame => frame.getByText(/you have reconnected to an existing session/i),
    10000
  );
  console.log(reconnectBanner
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
    console.error(
      `[request failed] ${safeUrlForLog(request.url())} | ` +
      `${request.failure()?.errorText || 'unknown error'}`
    );
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      console.error(`[HTTP ${response.status()}] ${safeUrlForLog(response.url())}`);
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
    const stopped = await findVisibleAcrossFrames(
      page,
      frame => frame.getByText(/notebook stopped/i),
      0
    );

    if (!stopped) {
        console.log('Notebook is not stopped.');
        return false;
    }

    console.log('Stopped sandbox detected.');

    const relaunch = await findVisibleAcrossFrames(
      page,
      frame => frame.getByRole('button', { name: /^relaunch$/i }),
      15000
    );
    if (!relaunch) throw new Error('Stopped notebook detected, but Relaunch button was not found.');
    await relaunch.locator.click();

    console.log('Relaunch clicked.');

    // Let the app rebuild the notebook in place. Reloading here can interrupt it.
    await page.waitForTimeout(15000);
    await findNotebookEditor(page, 60000);
    console.log('Notebook editor is available after relaunch.');

    return true;
}


main();
