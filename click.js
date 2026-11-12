
const { chromium } = require('playwright');
const fs = require('node:fs');

const NOTEBOOK_URLS = [
  'https://molab.marimo.io/notebooks/nb_wCrXdw7BuWwmmVTDna76EL',
  'https://molab.marimo.io/notebooks/nb_qmw8E5jTejuvsnpC8anUqq'
];

const DURATION = 345 * 60 * 1000;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function redactLogText(value) {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|api[_ -]?key|auth(?:entication)?)["'\s:=]+)[^\s,;"']+/gi, '$1[redacted]');
}

function appendLog(notebookNumber, message) {
  const entry = `[${new Date().toISOString()}] [notebook ${notebookNumber}] ${redactLogText(message)}`;
  console.log(`[notebook ${notebookNumber} log] ${redactLogText(message)}`);
  fs.appendFileSync('artifacts/notebook-logs.txt', `${entry}\n`, 'utf8');
}

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

  console.log('No safe blank position found; trying right-click then Escape at random points.');

  for (let attempt = 0; attempt < 8; attempt++) {
    const x = Math.floor(viewport.width * (0.2 + Math.random() * 0.6));
    const y = Math.floor(viewport.height * (0.2 + Math.random() * 0.6));

    await page.mouse.click(x, y, { button: 'right' });
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    console.log(`Dismissed context menu at x=${x}, y=${y} with Escape.`);
  }

  return true;
}

async function openLogsPanel(page, notebookNumber, state) {
  // marimo's developer panel is toggled with Ctrl/Cmd+J. The Logs tab exposes
  // stdout/stderr from notebook cells.
  await page.keyboard.press('Control+j').catch(() => {});
  await page.waitForTimeout(500);
  const logsTab = await findVisibleAcrossFrames(page, frame =>
    frame.getByRole('tab', { name: /^logs$/i }), 1000)
    || await findVisibleAcrossFrames(page, frame =>
      frame.getByRole('button', { name: /^logs$/i }), 1000)
    || await findVisibleAcrossFrames(page, frame => frame.getByText(/^logs$/i), 1000);
  if (logsTab) {
    const panelId = await logsTab.locator.getAttribute('aria-controls').catch(() => null);
    await logsTab.locator.click().catch(() => {});
    state.logPanel = panelId
      ? { frame: logsTab.frame, selector: `[id="${panelId.replaceAll('"', '\\"')}"]` }
      : { frame: logsTab.frame, selector: '[role="tabpanel"]' };
    console.log(`Opened the Logs panel for notebook ${notebookNumber}.`);
    return true;
  }
  throw new Error(`Notebook ${notebookNumber}: could not open the Molab Logs panel, so execution errors cannot be monitored.`);
}

async function readNotebookLogs(page, state) {
  if (state.logPanel) {
    const panel = state.logPanel.frame.locator(`${state.logPanel.selector}:visible`);
    const text = (await panel.innerText().catch(() => '')).trim();
    if (text) return text;
  }

  for (const frame of page.frames()) {
    const panels = frame.locator('[role="tabpanel"]:visible, [data-panel="logs"]:visible');
    const count = await panels.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const text = (await panels.nth(i).innerText().catch(() => '')).trim();
      if (text) return text;
    }
  }
  return '';
}

async function reportNewLogs(page, notebookNumber, state) {
  const snapshot = await readNotebookLogs(page, state);
  if (!snapshot || snapshot === state.lastSnapshot) return [];
  const newText = snapshot.startsWith(state.lastSnapshot)
    ? snapshot.slice(state.lastSnapshot.length).trim()
    : snapshot;
  state.lastSnapshot = snapshot;
  if (!newText) return [];

  const errors = newText.split(/\r?\n/).map(line => line.trim()).filter(line =>
    !/no visitor id available/i.test(line) &&
    /\b(error|failed)\b/i.test(line)
  );
  for (const line of errors) {
    appendLog(notebookNumber, line);
  }
  return errors;
}

function attachBrowserDiagnostics(page, notebookNumber, state) {
  page.on('pageerror', error => {
    if (/no visitor id available/i.test(error.message)) return;
    state.fatalError = `Browser page error: ${error.message}`;
    appendLog(notebookNumber, `[browser page error] ${error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      if (/no visitor id available/i.test(message.text())) return;
      state.fatalError = `Browser console error: ${message.text()}`;
      appendLog(notebookNumber, `[browser console error] ${message.text()}`);
    }
  });
  page.on('requestfailed', request => {
    const message = `[request failed] ${safeUrlForLog(request.url())} | ${request.failure()?.errorText || 'unknown error'}`;
    state.fatalError = message;
    appendLog(notebookNumber, message);
  });
  page.on('response', response => {
    if (response.status() >= 500) {
      const message = `[HTTP ${response.status()}] ${safeUrlForLog(response.url())}`;
      state.fatalError = message;
      appendLog(notebookNumber, message);
    }
  });
}

async function findNotebookEditor(page, timeout = 60000) {
  const selectors = [
    '.cm-editor .cm-content',
    '.cm-content',
    '.cm-content[contenteditable="true"]',
    '.monaco-editor [contenteditable="true"]',
    '.CodeMirror textarea',
    '[data-testid="notebook-cell"] [contenteditable="true"]',
    '[data-testid*="editor"] [contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea:not([disabled]):not([readonly])',
    '[role="textbox"]'
  ];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let index = 0; index < count; index++) {
          const editor = candidates.nth(index);
          const visible = await editor.isVisible().catch(() => false);
          const editable = visible && await editor.isEditable().catch(() => false);
          const active = editable && await editor.evaluate(element =>
            !element.closest('[inert]') &&
            getComputedStyle(element).pointerEvents !== 'none'
          ).catch(() => false);
          if (active) {
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
  const editableDetails = await Promise.all(page.frames().map(async frame => {
    const details = await frame.locator('textarea, [contenteditable], [role="textbox"]').evaluateAll(elements =>
      elements.slice(0, 20).map(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return `${element.tagName.toLowerCase()}.${String(element.className || '').replace(/\s+/g, '.')}` +
          ` role=${element.getAttribute('role') || '-'} contenteditable=${element.getAttribute('contenteditable') || '-'}` +
          ` aria=${element.getAttribute('aria-label') || '-'} visible=${rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'}` +
          ` disabled=${Boolean(element.disabled)} readonly=${Boolean(element.readOnly)}`;
      }).join(' || ')
    ).catch(() => 'unavailable');
    return `${safeUrlForLog(frame.url())}: ${details || '(none)'}`;
  }));
  throw new Error(
    `Notebook editor did not become active and editable within ${timeout} ms. URL: ${page.url()} | ` +
    `Title: ${await page.title().catch(() => 'unavailable')} | ` +
    `Buttons: ${buttons.flat().map(text => text.trim()).filter(Boolean).join(' | ') || '(none)'} | ` +
    `Frames: ${frameDetails.join(' || ') || '(none)'} | ` +
    `Editable candidates: ${editableDetails.join(' || ') || '(none)'}`
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

  const runOnServer = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run on server$/i }),
    30000
  );
  if (!runOnServer) throw new Error('Run on server confirmation did not appear.');
  console.log('Server confirmation dialog is open. Confirming run on server.');
  await runOnServer.locator.click();

  await page.waitForTimeout(5000);
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
  console.log('Visual review complete; server execution was not started in this review pass.');
}

async function restartIfReconnected(page, { required = false } = {}) {
  const timeout = required ? 3000 : 10000;
  const restartTarget = await findVisibleAcrossFrames(
    page,
    frame => frame.getByTestId('restart-session-button'),
    timeout
  ) || await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('link', { name: /^restart$/i }),
    1000
  ) || await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^restart$/i }),
    1000
  ) || await findVisibleAcrossFrames(
    page,
    frame => frame.getByText(/^restart$/i),
    1000
  );

  if (!restartTarget) {
    if (required) {
      throw new Error('The required blue Restart action was not found after opening the notebook.');
    }
    console.log('Blue Restart action was not found after refresh; continuing recovery.');
    return false;
  }

  console.log('Blue Restart link found.');
  console.log('Clicking the blue Restart link...');
  await restartTarget.locator.click();

  const confirmTarget = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^confirm restart$/i }),
    10000
  );
  if (!confirmTarget) {
    throw new Error('Clicked blue Restart, but Confirm Restart did not appear in the page or any iframe.');
  }
  console.log('Confirm Restart button found. Clicking it...');
  await confirmTarget.locator.click();
  console.log('Restart confirmed. Waiting for the notebook session...');
  await page.waitForTimeout(15000);

  const bodyText = (await Promise.all(page.frames().map(frame =>
    frame.locator('body').innerText().catch(() => '')
  ))).join(' ');
  const sessionError = /session.{0,80}(error|failed|expired|invalid|unavailable|closed|ended|not found|disconnected|could not|unable)|(?:error|failed|expired|invalid|not found|disconnected|could not|unable).{0,80}session/i;

  if (sessionError.test(bodyText)) {
    console.log('Session error detected after restart. Reloading the notebook once...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
  }

  return true;
}

async function recoverAllNotebooks(notebooks) {
  console.log('Interrupting notebook runs with Ctrl+I before recovery.');
  for (const { page } of notebooks) {
    if (!page.isClosed()) await page.keyboard.press('Control+i').catch(() => {});
  }
  await sleep(2000);

  for (const { page, state, notebookNumber } of notebooks) {
    if (page.isClosed()) throw new Error(`Notebook ${notebookNumber} page closed during recovery.`);
    console.log(`Refreshing notebook ${notebookNumber} with F5.`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await takeOverIfReader(page);

    const restarted = await restartIfReconnected(page);
    if (!restarted) {
      console.log(`Notebook ${notebookNumber}: blue Restart button did not appear; trying Run after refresh.`);
    }

    await openLogsPanel(page, notebookNumber, state);
    state.lastSnapshot = await readNotebookLogs(page, state);
    await page.keyboard.press('Control+j').catch(() => {});
    await page.waitForTimeout(500);

    const editor = await findNotebookEditor(page, 60000);
    await editor.click();
    await page.keyboard.press('Control+Shift+R');
    state.fatalError = null;
    console.log(`Notebook ${notebookNumber}: waiting 10 seconds for the rerun to initialize.`);
    await page.waitForTimeout(10000);
    await openLogsPanel(page, notebookNumber, state);
    console.log(`Notebook ${notebookNumber}: Ctrl+Shift+R sent after recovery.`);
  }
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
  return true;
}

async function main() {
  fs.mkdirSync('artifacts', { recursive: true });
  fs.appendFileSync('artifacts/notebook-logs.txt', `\n[${new Date().toISOString()}] Automation process started.\n`, 'utf8');

  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    storageState: 'auth.json',
    viewport: { width: 1365, height: 900 }
  });

  const notebooks = [];
  let recoveryUsed = false;

  try {
    for (let index = 0; index < NOTEBOOK_URLS.length; index++) {
      const notebookNumber = index + 1;
      const page = await context.newPage();
      const state = { lastSnapshot: '', fatalError: null };
      attachBrowserDiagnostics(page, notebookNumber, state);
      notebooks.push({ page, state, notebookNumber });

      try {
        console.log(`Opening Molab notebook ${notebookNumber}/${NOTEBOOK_URLS.length}: ${NOTEBOOK_URLS[index]}`);
        await page.goto(NOTEBOOK_URLS[index], { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
        await takeOverIfReader(page);

        if (process.argv.includes('--visual-review')) {
          await prepareVisualReview(page);
          continue;
        }

        // A reconnected session keeps the run control disabled until this session
        // restart is completed. Execution below targets the Run button directly.
        await restartIfReconnected(page, { required: true });
        await recoverNotebook(page);

        // Snapshot existing output before starting so old errors are not mistaken
        // for errors from this run. Close Logs while interacting with the editor.
        await openLogsPanel(page, notebookNumber, state);
        state.lastSnapshot = await readNotebookLogs(page, state);
        await page.keyboard.press('Control+j').catch(() => {});
        await page.waitForTimeout(500);

        const previewStarted = await startReadOnlyPreview(page);

        if (!previewStarted) {
          console.log(`Preparing notebook ${notebookNumber} execution...`);
          const editor = await findNotebookEditor(page, 60000);
          await editor.click();
          await page.keyboard.press('Control+Shift+R');
          console.log(`Notebook ${notebookNumber}: Ctrl+Shift+R sent while Logs is closed.`);
        }

        console.log(`Notebook ${notebookNumber}: waiting 10 seconds for execution to initialize.`);
        await page.waitForTimeout(10000);
        await openLogsPanel(page, notebookNumber, state);
      } catch (error) {
        const reason = error?.message || String(error);
        appendLog(notebookNumber, `[automation action failed] ${reason}`);
        if (recoveryUsed) throw new Error(`Setup failed again after one recovery: ${reason}`);
        if (/required blue Restart action was not found|Confirm Restart did not appear/i.test(reason)) {
          throw new Error(`Setup could not complete the required session restart: ${reason}`);
        }
        console.error(`Setup failed for notebook ${notebookNumber}: ${reason}`);
        recoveryUsed = true;
        await recoverAllNotebooks(notebooks);
      }
    }

    if (process.argv.includes('--visual-review')) return;

    // Keep notebook tabs alive and inspect only error-like lines from Logs.
    const endTime = Date.now() + DURATION;
    let lastHeartbeatAt = Date.now();
    while (Date.now() < endTime) {
      await sleep(5000);
      const issues = [];
      for (const { page, state, notebookNumber } of notebooks) {
        if (page.isClosed()) throw new Error(`Notebook ${notebookNumber} page was closed.`);
        const errors = await reportNewLogs(page, notebookNumber, state);
        if (errors.length) issues.push(`Notebook ${notebookNumber} Logs: ${errors.join(' | ')}`);
        if (state.fatalError) issues.push(`Notebook ${notebookNumber}: ${state.fatalError}`);
      }
      if (issues.length) {
        if (recoveryUsed) {
          throw new Error(`Still failing after one recovery. ${issues.join(' || ')}`);
        }
        console.error(`Execution error detected: ${issues.join(' || ')}`);
        recoveryUsed = true;
        await recoverAllNotebooks(notebooks);
      }
      if (Date.now() - lastHeartbeatAt >= 5 * 60 * 1000) {
        console.log(`Automation healthy; monitoring ${notebooks.length} notebook(s).`);
        lastHeartbeatAt = Date.now();
      }
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
