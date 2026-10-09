import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Client } from 'pg';
import { freePort, tempDir, TEST_DB_PASSWORD, TEST_DB_USER } from '../helpers/harness';

// The real server process (src/index.ts), started the way `npm run dev` starts it: it runs its own
// PostgreSQL, and has to stop it however it is stopped.

const SERVER_DIR = path.resolve(__dirname, '../..');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Run {
  child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Waits until the server has printed `text`. */
  waitFor(text: string | RegExp, timeoutMs?: number): Promise<void>;
}

describe('the server process', () => {
  const runs: Run[] = [];
  const folders: string[] = [];
  const dataDirs: string[] = [];

  async function setup() {
    const root = await tempDir('sqlgen-process-test-');
    folders.push(root);
    const dataDir = path.join(root, 'pg');
    dataDirs.push(dataDir);
    return { dataDir, apiPort: await freePort(), dbPort: await freePort() };
  }

  function launch(env: Record<string, string>): Run {
    // Every setting is given, even when empty, so that a developer's server/.env changes nothing.
    const child = spawn(process.execPath, ['--require', 'ts-node/register', 'src/index.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: '', DB_HOST: '', DB_PORT: '', DB_NAME: '', DB_USER: TEST_DB_USER, DB_PASSWORD: TEST_DB_PASSWORD,
        DB_READONLY_USER: '', DB_READONLY_PASSWORD: '', DB_EMBEDDED: '', DB_DATA_DIR: '',
        OPENROUTER_API_KEY: 'test-key', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: '', LLM_JSON_MODE: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', chunk => (output += chunk));
    child.stderr!.on('data', chunk => (output += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal }))
    );
    const run: Run = {
      child,
      output: () => output,
      exited,
      async waitFor(text, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (typeof text === 'string' ? output.includes(text) : text.test(output)) return;
          if (child.exitCode !== null) throw new Error(`The server exited (${child.exitCode}) before printing ${text}:\n${output}`);
          await sleep(100);
        }
        throw new Error(`Timed out waiting for ${text}. Output so far:\n${output}`);
      },
    };
    runs.push(run);
    return run;
  }

  const serverEnv = ({ dataDir, apiPort, dbPort }: { dataDir: string; apiPort: number; dbPort: number }) => ({
    PORT: String(apiPort), DB_PORT: String(dbPort), DB_NAME: 'sqlgen', DB_DATA_DIR: dataDir, DB_HOST: '127.0.0.1',
  });

  async function connect(dbPort: number) {
    const client = new Client({ host: '127.0.0.1', port: dbPort, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: 'sqlgen' });
    await client.connect();
    return client;
  }

  async function assertDatabaseStopped({ dataDir, dbPort }: { dataDir: string; dbPort: number }) {
    await assert.rejects(() => connect(dbPort), { code: 'ECONNREFUSED' });
    assert.equal(existsSync(path.join(dataDir, 'postmaster.pid')), false, 'the lock file is still there');
  }

  /** A database left running by a test (kill -9 cases, or a failure) must not outlive it. */
  async function stopLeftoverDatabase(dataDir: string) {
    let pid: number;
    try {
      pid = Number(readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
      process.kill(pid, 'SIGINT');
    } catch {
      return; // not running
    }
    for (let attempt = 0; attempt < 150; attempt++) {
      try { process.kill(pid, 0); } catch { return; }
      await sleep(100);
    }
    process.kill(pid, 'SIGKILL');
  }

  afterEach(async () => {
    for (const run of runs.splice(0)) run.child.kill('SIGKILL');
    for (const dataDir of dataDirs.splice(0)) await stopLeftoverDatabase(dataDir);
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  });

  it('starts the API and its own PostgreSQL', async () => {
    const ports = await setup();
    const run = launch(serverEnv(ports));

    await run.waitFor('Server running on port');

    assert.match(run.output(), /PostgreSQL started on port/);
    const api = await fetch(`http://127.0.0.1:${ports.apiPort}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(api.status, 400, 'the API answers');
    const client = await connect(ports.dbPort);
    try {
      const { rows } = await client.query("SELECT to_regclass('table_schema') IS NOT NULL AS ready");
      assert.deepEqual(rows, [{ ready: true }], 'the application tables are created');
    } finally {
      await client.end();
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`stops the API and the database on ${signal}${signal === 'SIGHUP' ? ' (closing the terminal)' : ''}`, async () => {
      const ports = await setup();
      const run = launch(serverEnv(ports));
      await run.waitFor('Server running on port');

      run.child.kill(signal);

      assert.deepEqual(await run.exited, { code: 0, signal: null });
      await assertDatabaseStopped(ports);
      await assert.rejects(() => fetch(`http://127.0.0.1:${ports.apiPort}/`), 'the API no longer answers');
    });
  }

  it('keeps the data between two runs', async () => {
    const ports = await setup();
    const first = launch(serverEnv(ports));
    await first.waitFor('Server running on port');
    let client = await connect(ports.dbPort);
    await client.query('CREATE TABLE kept (id int); INSERT INTO kept VALUES (1), (2)');
    await client.end();
    first.child.kill('SIGINT');
    await first.exited;

    const second = launch(serverEnv(ports));
    await second.waitFor('Server running on port');

    client = await connect(ports.dbPort);
    try {
      assert.deepEqual((await client.query('SELECT count(*)::int AS n FROM kept')).rows, [{ n: 2 }]);
    } finally {
      await client.end();
    }
  });

  it('takes over a database left running by a run killed with kill -9, and stops it', async () => {
    const ports = await setup();
    const first = launch(serverEnv(ports));
    await first.waitFor('Server running on port');
    first.child.kill('SIGKILL');
    await first.exited;
    await (await connect(ports.dbPort)).end(); // the database outlived the server

    const second = launch(serverEnv(ports));
    await second.waitFor('Server running on port');
    assert.match(second.output(), /left running by a previous run taken over/);
    second.child.kill('SIGTERM');
    await second.exited;

    await assertDatabaseStopped(ports);
  });

  it('refuses to start without OPENROUTER_API_KEY, before starting any database', async () => {
    const ports = await setup();
    const run = launch({ ...serverEnv(ports), OPENROUTER_API_KEY: '' });

    assert.deepEqual(await run.exited, { code: 1, signal: null });
    assert.match(run.output(), /Failed to start server: OPENROUTER_API_KEY is not set/);
    assert.match(run.output(), /openrouter\.ai\/keys/);
    await assert.rejects(() => connect(ports.dbPort), { code: 'ECONNREFUSED' });
    assert.equal(existsSync(ports.dataDir), false, 'no database was created');
  });

  it('refuses to start when the database port is used by another program', async () => {
    const ports = await setup();
    const sockets = new Set<net.Socket>();
    const other = net.createServer(socket => { sockets.add(socket); socket.end(); });
    await new Promise<void>(resolve => other.listen(ports.dbPort, '127.0.0.1', resolve));
    try {
      const run = launch(serverEnv(ports));

      assert.deepEqual(await run.exited, { code: 1, signal: null });
      assert.match(run.output(), new RegExp(`Failed to start server: Port ${ports.dbPort} is already used by another program`));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => other.close(() => resolve()));
    }
  });

  it('does not leave its database running when the API port is already taken', async () => {
    const ports = await setup();
    const sockets = new Set<net.Socket>();
    const other = net.createServer(socket => { sockets.add(socket); socket.end(); });
    await new Promise<void>(resolve => other.listen(ports.apiPort, '127.0.0.1', resolve));
    try {
      const run = launch(serverEnv(ports));

      assert.deepEqual(await run.exited, { code: 1, signal: null });
      assert.match(run.output(), new RegExp(`Failed to start server: Port ${ports.apiPort} is already used by another program`));
      assert.match(run.output(), /PORT/, 'tells which setting to change');
      await assertDatabaseStopped(ports);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => other.close(() => resolve()));
    }
  });
});
