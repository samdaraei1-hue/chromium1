const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const artifacts = path.join(__dirname, 'artifacts');
const managerLog = path.join(artifacts, 'automation.log');
fs.mkdirSync(artifacts, { recursive: true });

let child = null;
let stopping = false;
let restarting = false;
let startedAt = null;
let restartCount = 0;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(managerLog, `${line}\n`, 'utf8');
  console.log(line);
}

function start() {
  if (stopping) return;
  child = spawn(process.execPath, [path.join(__dirname, 'click.js')], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  startedAt = new Date();
  const current = child;
  log(`Automation started (PID ${current.pid}).`);
  for (const [stream, label] of [[current.stdout, 'OUT'], [current.stderr, 'ERR']]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) log(`[${label}] ${line}`);
    });
    stream.on('end', () => { if (pending.trim()) log(`[${label}] ${pending}`); });
  }
  current.on('error', error => log(`Could not start automation: ${error.message}`));
  current.on('close', (code, signal) => {
    if (child !== current) return;
    child = null;
    log(`Automation exited (code ${code ?? 'none'}, signal ${signal || 'none'}).`);
    if (stopping) return;
    if (restarting) {
      restarting = false;
      start();
    } else if (code !== 0) {
      restartCount++;
      log('Restarting automatically in 5 seconds after an error.');
      setTimeout(start, 5000);
    }
  });
}

const commands = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('Commands: s = status, r = restart, q = quit');
commands.on('line', input => {
  const command = input.trim().toLowerCase();
  if (command === 's') {
    console.log(`Status: ${child ? `running (PID ${child.pid}, since ${startedAt.toLocaleString()})` : 'stopped'}; automatic restarts: ${restartCount}`);
    console.log(`Logs: ${managerLog} and ${path.join(artifacts, 'notebook-logs.txt')}`);
  } else if (command === 'r') {
    if (!child) {
      restarting = true;
      log('Restart requested; starting automation.');
      start();
    } else {
      restarting = true;
      log('Restart requested. Stopping current automation...');
      child.kill();
    }
  } else if (command === 'q') {
    stopping = true;
    log('Manager stopping automation.');
    if (child) child.kill();
    else process.exit(0);
    commands.close();
  } else if (command) {
    console.log('Unknown command. Use s, r, or q.');
  }
});

start();
