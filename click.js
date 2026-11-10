
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

    // Step 2: Run exactly once

    console.log('Preparing notebook execution...');

    // Focus the notebook editor
    const editor = page.locator(
        '.cm-editor .cm-content'
    ).first();

    await editor.waitFor({
        state: 'visible',
        timeout: 30000
    });

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
    const stopped = page.getByText(
        'Notebook stopped',
        { exact: true }
    );

    if (await stopped.count() === 0) {
        console.log('Notebook is not stopped.');
        return false;
    }

    console.log('Stopped sandbox detected.');

    const relaunch = page.getByRole('button', {
        name: /^relaunch$/i
    });

    await relaunch.waitFor({
        state: 'visible',
        timeout: 15000
    });

    await relaunch.click();

    console.log('Relaunch clicked.');

    // Wait for the relaunch process.
    await page.waitForTimeout(15000);

    // Refresh after relaunch.
    await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForTimeout(10000);

    console.log('Notebook page refreshed.');

    return true;
}


main();
