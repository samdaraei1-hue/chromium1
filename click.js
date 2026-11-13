
const { chromium } = require('playwright');
const fs = require('node:fs');

const NOTEBOOK_URLS = [
  'https://molab.marimo.io/notebooks/nb_wCrXdw7BuWwmmVTDna76EL',
  'https://molab.marimo.io/notebooks/nb_qmw8E5jTejuvsnpC8anUqq'
];

const DURATION = 345 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function redactLogText(value) {
  return String(value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|api[_ -]?key|auth(?:entication)?)["'\s:=]+)[^\s,;"']+/gi, '$1[redacted]');
}

function appendLog(number, message) {
  const safe = redactLogText(message);
  const entry = `[${new Date().toISOString()}] [notebook ${number}] ${safe}`;
  console.log(entry);
  fs.appendFileSync('artifacts/notebook-logs.txt', entry + '\n');
}

function safeUrlForLog(raw) {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname.replace(
      /\/session\/[^/]+/i,
      '/session/[redacted]'
    );
  } catch {
    return '[unparseable URL]';
  }
}

async function findVisibleAcrossFrames(page, factory, timeout = 0) {
  const deadline = Date.now() + timeout;

  do {
    for (const frame of page.frames()) {
      const candidates = factory(frame);
      const count = await candidates.count().catch(() => 0);

      for (let i = 0; i < count; i++) {
        const locator = candidates.nth(i);
        if (await locator.isVisible().catch(() => false)) {
          return { locator, frame };
        }
      }
    }

    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (Date.now() < deadline);

  return null;
}

async function takeOverIfReader(page) {
  const target =
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByTestId('takeover-button'),
      2000
    ) ||
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByRole('button', { name: /take over/i }),
      1000
    );

  if (!target) {
    console.log('Take over not found. Continuing.');
    return false;
  }

  console.log('Take over found. Clicking...');
  await target.locator.click({ timeout: 10000 });
  await sleep(3000);
  return true;
}

async function restartIfReconnected(page) {
  const target =
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByTestId('restart-session-button'),
      3000
    ) ||
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByRole('button', { name: /^restart$/i }),
      1000
    );

  if (!target) {
    console.log('Restart not found. Skipping.');
    return false;
  }

  console.log('Restart found. Clicking...');
  await target.locator.click({ timeout: 10000 });

  const confirm = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', {
      name: /^confirm restart$/i
    }),
    10000
  );

  if (confirm) {
    console.log('Confirming Restart...');
    await confirm.locator.click({ timeout: 10000 });
  } else {
    console.log('Restart confirmation not shown.');
  }

  await sleep(10000);
  return true;
}

async function recoverNotebook(page) {
  const stopped = await findVisibleAcrossFrames(
    page,
    frame => frame.getByText(/notebook stopped/i),
    1000
  );

  if (!stopped) return false;

  console.log('Notebook stopped. Looking for Relaunch...');

  const relaunch = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^relaunch$/i }),
    10000
  );

  if (!relaunch) {
    console.log('Relaunch not found. Continuing to editor check.');
    return false;
  }

  await relaunch.locator.click({ timeout: 10000 });
  console.log('Relaunch clicked.');
  await sleep(15000);
  return true;
}

async function startReadOnlyPreview(page) {
  const preview = await findVisibleAcrossFrames(
    page,
    frame => frame.getByText(/read-only preview/i),
    1000
  );

  if (!preview) return false;

  console.log('Read-only preview detected.');

  const runNow = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run it now$/i }),
    15000
  );

  if (!runNow) {
    throw new Error('Read-only preview found but Run it now is missing.');
  }

  await runNow.locator.click();

  const runOnServer = await findVisibleAcrossFrames(
    page,
    frame => frame.getByRole('button', { name: /^run on server$/i }),
    30000
  );

  if (!runOnServer) {
    throw new Error('Run on server confirmation missing.');
  }

  await runOnServer.locator.click();
  await sleep(5000);
  return true;
}

async function findNotebookEditor(page, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let takeoverAttempted = false;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const editors = frame.locator('.cm-editor .cm-content');
      const count = await editors.count().catch(() => 0);

      for (let i = 0; i < count; i++) {
        const editor = editors.nth(i);

        if (
          await editor.isVisible().catch(() => false) &&
          await editor.isEditable().catch(() => false)
        ) {
          return editor;
        }
      }
    }

    if (!takeoverAttempted) {
      takeoverAttempted = true;
      if (await takeOverIfReader(page)) {
        await restartIfReconnected(page);
      }
    }

    await sleep(1000);
  }

  const details = [];

  for (const frame of page.frames()) {
    const body = await frame.locator('body')
      .innerText()
      .catch(() => '');

    details.push(
      `${safeUrlForLog(frame.url())}: ${body.slice(0, 500)}`
    );
  }

  throw new Error(
    'Editable notebook editor not found. ' + details.join(' | ')
  );
}

async function openLogsPanel(page, number, state) {
  await page.keyboard.press('Control+j').catch(() => {});
  await sleep(500);

  const tab =
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByRole('tab', { name: /^logs$/i }),
      1500
    ) ||
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByRole('button', { name: /^logs$/i }),
      1000
    ) ||
    await findVisibleAcrossFrames(
      page,
      frame => frame.getByText(/^logs$/i),
      1000
    );

  if (!tab) {
    console.log(`Notebook ${number}: Logs panel unavailable.`);
    state.logPanel = null;
    return false;
  }

  const panelId = await tab.locator
    .getAttribute('aria-controls')
    .catch(() => null);

  await tab.locator.click().catch(() => {});

  state.logPanel = {
    frame: tab.frame,
    selector: panelId
      ? `[id="${panelId.replaceAll('"', '\\"')}"]`
      : '[role="tabpanel"]'
  };

  console.log(`Notebook ${number}: Logs panel opened.`);
  return true;
}

async function readNotebookLogs(page, state) {
  if (state.logPanel) {
    const panel = state.logPanel.frame.locator(
      `${state.logPanel.selector}:visible`
    );

    const content = await panel.innerText().catch(() => '');
    if (content.trim()) return content.trim();
  }

  for (const frame of page.frames()) {
    const panels = frame.locator(
      '[role="tabpanel"]:visible, [data-panel="logs"]:visible'
    );

    const count = await panels.count().catch(() => 0);

    for (let i = count - 1; i >= 0; i--) {
      const content = await panels.nth(i)
        .innerText()
        .catch(() => '');

      if (content.trim()) return content.trim();
    }
  }

  return '';
}

async function reportNewLogs(page, number, state) {
  const snapshot = await readNotebookLogs(page, state);

  if (!snapshot || snapshot === state.lastSnapshot) return [];

  const newText = snapshot.startsWith(state.lastSnapshot)
    ? snapshot.slice(state.lastSnapshot.length)
    : snapshot;

  state.lastSnapshot = snapshot;

  const errors = newText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      /\b(error|failed)\b/i.test(line) &&
      !/no visitor id available/i.test(line)
    );

  for (const error of errors) appendLog(number, error);

  return errors;
}

function attachBrowserDiagnostics(page, number, state) {
  page.on('pageerror', error => {
    if (/no visitor id available/i.test(error.message)) return;

    state.fatalError = `Browser page error: ${error.message}`;
    appendLog(number, state.fatalError);
  });

  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/no visitor id available/i.test(message.text())) return;

    appendLog(number, `[browser console error] ${message.text()}`);
  });

  page.on('requestfailed', request => {
    const message =
      `[request failed] ${safeUrlForLog(request.url())} | ` +
      (request.failure()?.errorText || 'unknown');

    appendLog(number, message);
  });

  page.on('response', response => {
    if (response.status() >= 500) {
      appendLog(
        number,
        `[HTTP ${response.status()}] ${safeUrlForLog(response.url())}`
      );
    }
  });
}

async function executeNotebook(page, number, state) {
  console.log(`Notebook ${number}: checking page state...`);

  await takeOverIfReader(page);
  await restartIfReconnected(page);
  await recoverNotebook(page);

  const previewStarted = await startReadOnlyPreview(page);

  if (!previewStarted) {
    const editor = await findNotebookEditor(page, 60000);

    await editor.click();
    await page.keyboard.press('Control+Shift+R');

    console.log(`Notebook ${number}: Run shortcut sent.`);
  } else {
    console.log(`Notebook ${number}: server run started.`);
  }

  await sleep(10000);

  state.lastSnapshot = '';
  state.fatalError = null;

  await openLogsPanel(page, number, state);

  console.log(`Notebook ${number}: setup complete.`);
}

async function recoverAllNotebooks(notebooks) {
  console.log('Starting recovery...');

  for (const notebook of notebooks) {
    if (!notebook.ready || notebook.page.isClosed()) continue;

    await notebook.page.keyboard
      .press('Control+i')
      .catch(() => {});
  }

  await sleep(2000);

  for (const notebook of notebooks) {
    const { page, state, notebookNumber } = notebook;

    if (page.isClosed()) {
      throw new Error(`Notebook ${notebookNumber} page closed.`);
    }

    console.log(`Recovering notebook ${notebookNumber}...`);

    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await sleep(5000);
    await executeNotebook(page, notebookNumber, state);
    notebook.ready = true;
  }

  console.log('Recovery completed.');
}

async function main() {
  fs.mkdirSync('artifacts', { recursive: true });

  fs.appendFileSync(
    'artifacts/notebook-logs.txt',
    `\n[${new Date().toISOString()}] Automation started.\n`
  );

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
    for (let i = 0; i < NOTEBOOK_URLS.length; i++) {
      const notebookNumber = i + 1;
      const page = await context.newPage();

      const state = {
        lastSnapshot: '',
        fatalError: null,
        logPanel: null
      };

      const notebook = {
        page,
        state,
        notebookNumber,
        ready: false
      };

      notebooks.push(notebook);
      attachBrowserDiagnostics(page, notebookNumber, state);

      console.log(
        `Opening notebook ${notebookNumber}/${NOTEBOOK_URLS.length}`
      );

      await page.goto(NOTEBOOK_URLS[i], {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await sleep(5000);

      if (process.argv.includes('--visual-review')) {
        console.log(`Notebook ${notebookNumber}: visual review loaded.`);
        continue;
      }

      try {
        await executeNotebook(page, notebookNumber, state);
        notebook.ready = true;
      } catch (error) {
        appendLog(
          notebookNumber,
          `[setup failed] ${error.message}`
        );

        if (recoveryUsed) throw error;

        recoveryUsed = true;

        await recoverAllNotebooks(notebooks);
      }
    }

    if (process.argv.includes('--visual-review')) return;

    const endTime = Date.now() + DURATION;
    let lastHeartbeat = Date.now();

    while (Date.now() < endTime) {
      await sleep(5000);

      const issues = [];

      for (const notebook of notebooks) {
        const { page, state, notebookNumber } = notebook;

        if (page.isClosed()) {
          issues.push(`Notebook ${notebookNumber} page closed.`);
          continue;
        }

        const errors = await reportNewLogs(
          page,
          notebookNumber,
          state
        );

        if (errors.length) {
          issues.push(
            `Notebook ${notebookNumber}: ${errors.join(' | ')}`
          );
        }

        if (state.fatalError) {
          issues.push(
            `Notebook ${notebookNumber}: ${state.fatalError}`
          );
        }
      }

      if (issues.length) {
        if (recoveryUsed) {
          throw new Error(
            `Still failing after recovery: ${issues.join(' || ')}`
          );
        }

        console.error('Errors detected:', issues.join(' || '));
        recoveryUsed = true;

        await recoverAllNotebooks(notebooks);
      }

      if (Date.now() - lastHeartbeat >= 5 * 60 * 1000) {
        console.log(
          `Automation healthy. Monitoring ${notebooks.length} notebooks.`
        );

        lastHeartbeat = Date.now();
      }
    }

    console.log('Session duration completed.');

  } catch (error) {
    console.error('Automation error:', redactLogText(error.message));
    process.exitCode = 1;

  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', redactLogText(error.message));
  process.exitCode = 1;
});
