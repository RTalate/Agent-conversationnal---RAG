import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// npm run dev (scripts/project.mjs dev): the API, its database and the interface, started and stopped together.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WINDOWS = process.platform === 'win32';
// Ctrl-C is a signal sent to the whole process group of the terminal: Windows has no such thing to send.
const CTRL_C = WINDOWS && 'Windows has no signals to send';
// A test that hangs fails on its own rather than holding up the whole file.
const LIMIT = { timeout: 240_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const refused = port =>
  new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  });

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('npm run dev', () => {
  const runs = [];
  const folders = [];

  async function setup() {
    // A folder PostgreSQL can use even when the tests run as root (it then runs as "postgres").
    const root = mkdtempSync(path.join(tmpdir(), 'sqlgen-dev-test-'));
    chmodSync(root, 0o755);
    folders.push(root);
    return { dataDir: path.join(root, 'pg'), apiPort: await freePort(), dbPort: await freePort(), uiPort: await freePort() };
  }

  function launch({ dataDir, apiPort, dbPort, uiPort }, env = {}) {
    // Every setting is given, even when empty, so that a developer's server/.env changes nothing.
    const settings = {
      ...process.env,
      PORT: String(apiPort), API_HOST: '', UI_PORT: String(uiPort),
      DB_PORT: String(dbPort), DB_DATA_DIR: dataDir, DB_HOST: '127.0.0.1', DB_NAME: 'sqlgen', DB_EMBEDDED: '',
      DB_USER: 'postgres', DB_PASSWORD: 'test-password', DB_READONLY_USER: '', DB_READONLY_PASSWORD: '',
      OPENROUTER_API_KEY: 'test-key', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: '', LLM_JSON_MODE: '',
      ...env,
    };
    delete settings.VITE_API_URL;
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'project.mjs'), 'dev'], {
      cwd: ROOT,
      env: settings,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, as in a terminal: Ctrl-C is sent to the group, and the test can clean it up.
      detached: !WINDOWS,
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const run = {
      child,
      dataDir,
      exited,
      output: () => output,
      async waitFor(text, timeoutMs = 180_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (typeof text === 'string' ? output.includes(text) : text.test(output)) return;
          if (child.exitCode !== null) throw new Error(`npm run dev exited (${child.exitCode}) before printing ${text}:\n${output}`);
          await sleep(100);
        }
        throw new Error(`Timed out waiting for ${text}. Output so far:\n${output}`);
      },
    };
    runs.push(run);
    return run;
  }

  async function assertEverythingStopped({ dataDir, apiPort, dbPort }) {
    assert.ok(await refused(dbPort), 'the database still answers');
    assert.ok(await refused(apiPort), 'the API still answers');
    assert.equal(existsSync(path.join(dataDir, 'postmaster.pid')), false, 'the database lock file is still there');
  }

  afterEach(async () => {
    for (const run of runs.splice(0)) {
      if (WINDOWS) run.child.kill();
      else {
        try {
          process.kill(-run.child.pid, 'SIGKILL'); // the launcher and whatever it left
        } catch {}
      }
      // A database left running by a failed test.
      try {
        const pid = Number(readFileSync(path.join(run.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
        process.kill(pid, 'SIGINT');
        for (let attempt = 0; attempt < 150 && isAlive(pid); attempt++) await sleep(100);
      } catch {}
    }
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('starts the API with its database, then the interface pointed at that API', LIMIT, async () => {
    const ports = await setup();
    const run = launch(ports);

    await run.waitFor(`Ready: open http://localhost:${ports.uiPort} in your browser`);

    assert.match(run.output(), /\[api\] PostgreSQL started on port/);
    assert.ok(run.output().indexOf('[api] Server running on port') < run.output().indexOf('[ui]'), 'the interface starts once the API is ready');
    const api = await fetch(`http://127.0.0.1:${ports.apiPort}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(api.status, 400);
    const page = await fetch(`http://localhost:${ports.uiPort}/`);
    assert.match(await page.text(), /<div id="root">/);
    const app = await (await fetch(`http://localhost:${ports.uiPort}/src/App.tsx`)).text();
    assert.ok(app.includes(`http://127.0.0.1:${ports.apiPort}`), 'the interface calls the API on its port');
  });

  it('stops the interface, the API and the database on Ctrl-C', { ...LIMIT, skip: CTRL_C }, async () => {
    const ports = await setup();
    const run = launch(ports);
    await run.waitFor('Ready: open');

    process.kill(-run.child.pid, 'SIGINT');

    assert.deepEqual(await run.exited, { code: 0, signal: null });
    await assertEverythingStopped(ports);
    await assert.rejects(() => fetch(`http://localhost:${ports.uiPort}/`), 'the interface still answers');
  });

  it('stops the API and the database when it is stopped itself (closing the terminal)', { ...LIMIT, skip: CTRL_C }, async () => {
    const ports = await setup();
    const run = launch(ports);
    await run.waitFor('Ready: open');

    run.child.kill('SIGHUP');

    assert.deepEqual(await run.exited, { code: 0, signal: null });
    await assertEverythingStopped(ports);
  });

  it('does not start the interface when the API cannot start', LIMIT, async () => {
    const ports = await setup();
    const other = net.createServer(socket => socket.destroy()).listen(ports.dbPort, '127.0.0.1');
    await new Promise(resolve => other.once('listening', resolve));
    try {
      const run = launch(ports);

      assert.deepEqual(await run.exited, { code: 1, signal: null });
      assert.match(run.output(), /\[api\] Failed to start server: Port \d+ is already used by another program/);
      assert.match(run.output(), /The API did not start: see its message above/);
      assert.doesNotMatch(run.output(), /\[ui\]/);
    } finally {
      await new Promise(resolve => other.close(resolve));
    }
  });

  it('stops the API and the database when the interface cannot start', LIMIT, async () => {
    const ports = await setup();
    // Another program on the port of the interface, at the addresses it uses. (On Windows, a program
    // listening on every address does not prevent another from taking one of them.)
    const others = [];
    for (const host of ['127.0.0.1', '::1']) {
      const other = net.createServer();
      await new Promise(resolve => other.once('error', resolve).listen(ports.uiPort, host, resolve));
      if (other.listening) others.push(other);
    }
    try {
      const run = launch(ports);

      assert.deepEqual(await run.exited, { code: 1, signal: null });
      assert.match(run.output(), /The interface stopped: stopping the API/);
      await assertEverythingStopped(ports);
    } finally {
      for (const other of others) await new Promise(resolve => other.close(resolve));
    }
  });

  it('lets the API stop its database when it is killed outright', { ...LIMIT, skip: CTRL_C }, async () => {
    const ports = await setup();
    const run = launch(ports);
    await run.waitFor('Ready: open');

    run.child.kill('SIGKILL');
    await run.exited;

    for (let attempt = 0; attempt < 150 && !(await refused(ports.dbPort)); attempt++) await sleep(100);
    await assertEverythingStopped(ports);
  });
});
