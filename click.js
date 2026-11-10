
const { chromium } = require('playwright');

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
  const excerpt = bodyText.replace(/\s+/g, ' ').trim().slice(0, 1200);
  throw new Error(
    `Notebook editor did not appear. URL: ${page.url()} | ` +
    `Title: ${await page.title().catch(() => 'unavailable')} | ` +
    `Visible page text: ${excerpt || '(empty)'}`
  );
}

async function main() {
  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    storageState: 'auth.json',
    viewport: { width: 1365, height: 900 }
  });

  const page = await context.newPage();

  try {
    console.log('Opening Molab...');

    await page.goto(SITE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    // Step 1: Take over if available
    const takeOver = page.getByRole('button', {
      name: /take over/i
    });

    if (await takeOver.count() > 0 &&
        await takeOver.first().isVisible()) {

      console.log('Reader mode detected. Taking over...');

      await takeOver.first().click();

      await page.waitForTimeout(5000);
    } else {
      console.log('Take over not required.');
    }

    // A stopped sandbox has no editor until it is relaunched.
    await recoverNotebook(page);

    // Step 2: Run exactly once

    console.log('Preparing notebook execution...');

    // Focus the notebook editor
    const editor = await findNotebookEditor(page, 60000);

    await editor.click();

    // Run all stale cells once
    await page.keyboard.press('Control+Shift+R');

    console.log('Run all shortcut sent successfully.');


    console.log('Notebook Run clicked once.');

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
