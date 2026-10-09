import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Client } from 'pg';
import { EmbeddedDatabaseError, startEmbeddedPostgres, type EmbeddedDatabase, type EmbeddedDatabaseOptions } from '../../src/embedded-postgres';
import { freePort, tempDir, TEST_DB_PASSWORD, TEST_DB_USER } from '../helpers/harness';

// The embedded PostgreSQL is what replaces Docker: these tests cover how it starts, stops and recovers.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('startEmbeddedPostgres', () => {
  const running: EmbeddedDatabase[] = [];
  const folders: string[] = [];

  async function newOptions(overrides: Partial<EmbeddedDatabaseOptions> = {}): Promise<EmbeddedDatabaseOptions> {
    const root = await tempDir('sqlgen-embedded-test-');
    folders.push(root);
    return { dataDir: path.join(root, 'pg'), port: await freePort(), user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: 'app', ...overrides };
  }

  /** Starts a server and remembers it, so that a failing test does not leave it running. */
  async function start(options: EmbeddedDatabaseOptions): Promise<EmbeddedDatabase> {
    const database = await startEmbeddedPostgres(options);
    running.push(database);
    return database;
  }

  async function connect(options: EmbeddedDatabaseOptions, { database = options.database, password = options.password } = {}) {
    const client = new Client({ host: '127.0.0.1', port: options.port, user: options.user, password, database });
    await client.connect();
    return client;
  }

  const pidOf = (options: EmbeddedDatabaseOptions) => Number(readFileSync(path.join(options.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);

  async function assertNothingListens(options: EmbeddedDatabaseOptions) {
    await assert.rejects(() => connect(options), { code: 'ECONNREFUSED' });
  }

  afterEach(async () => {
    for (const database of running.splice(0)) await database.stop().catch(() => {});
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  });

  it('starts a server with the database, and accepts the credentials', async () => {
    const options = await newOptions();

    const database = await start(options);

    assert.equal(database.source, 'started');
    const client = await connect(options);
    try {
      assert.deepEqual((await client.query('SELECT current_database() AS name')).rows, [{ name: 'app' }]);
    } finally {
      await client.end();
    }
  });

  it('only listens on the local machine', async () => {
    const options = await newOptions();
    await start(options);

    const client = await connect(options);
    try {
      assert.deepEqual((await client.query('SHOW listen_addresses')).rows, [{ listen_addresses: 'localhost' }]);
    } finally {
      await client.end();
    }
  });

  it('rejects a wrong password', async () => {
    const options = await newOptions();
    await start(options);

    await assert.rejects(() => connect(options, { password: 'not-the-password' }), { code: '28P01' });
  });

  it('stops the server it started: nothing listens and the lock file is gone', async () => {
    const options = await newOptions();
    const database = await start(options);
    assert.ok(existsSync(path.join(options.dataDir, 'postmaster.pid')));

    await database.stop();

    await assertNothingListens(options);
    assert.equal(existsSync(path.join(options.dataDir, 'postmaster.pid')), false);
  });

  it('keeps the data between two runs', async () => {
    const options = await newOptions();
    const first = await start(options);
    let client = await connect(options);
    await client.query('CREATE TABLE notes (id int); INSERT INTO notes VALUES (1), (2), (3)');
    await client.end();
    await first.stop();

    const second = await start(options);

    assert.equal(second.source, 'started', 'the data folder already exists: it is reused, not recreated');
    client = await connect(options);
    try {
      assert.deepEqual((await client.query('SELECT count(*)::int AS n FROM notes')).rows, [{ n: 3 }]);
    } finally {
      await client.end();
    }
  });

  it('creates the database when the server already exists without it', async () => {
    const options = await newOptions({ database: 'first' });
    const first = await start(options);
    await first.stop();

    await start({ ...options, database: 'second' });

    const client = await connect(options, { database: 'postgres' });
    try {
      const { rows } = await client.query("SELECT datname FROM pg_database WHERE datname IN ('first', 'second') ORDER BY 1");
      assert.deepEqual(rows.map(row => row.datname), ['first', 'second']);
    } finally {
      await client.end();
    }
  });

  describe('a server left running by a previous run (terminal closed, kill -9)', () => {
    it('is taken over, and stopped with the new run', async () => {
      const options = await newOptions();
      await start(options); // never stopped: the previous run is gone

      const taken = await startEmbeddedPostgres(options);

      assert.equal(taken.source, 'adopted');
      await (await connect(options)).end(); // still usable
      await taken.stop();
      await assertNothingListens(options);
      running.length = 0; // the first handle refers to a server that no longer exists
    });

    it('recovers when the server itself was killed (kill -9), without losing committed data', async () => {
      const options = await newOptions();
      await start(options);
      const client = await connect(options);
      await client.query('CREATE TABLE notes (id int); INSERT INTO notes VALUES (1), (2)');
      await client.end();
      const pid = pidOf(options);

      process.kill(pid, 'SIGKILL');
      await sleep(1500); // the other PostgreSQL processes notice and exit
      assert.ok(existsSync(path.join(options.dataDir, 'postmaster.pid')), 'a stale lock file is left behind');
      running.length = 0;

      const restarted = await start(options);

      assert.equal(restarted.source, 'started');
      const again = await connect(options);
      try {
        assert.deepEqual((await again.query('SELECT count(*)::int AS n FROM notes')).rows, [{ n: 2 }]);
      } finally {
        await again.end();
      }
    });
  });

  describe('a server it does not own', () => {
    it('is used as it is and never stopped', async () => {
      const options = await newOptions();
      const owner = await start(options);
      const elsewhere = { ...options, dataDir: path.join(path.dirname(options.dataDir), 'another-folder') };

      const external = await startEmbeddedPostgres(elsewhere);
      assert.equal(external.source, 'external');
      await external.stop();

      await (await connect(options)).end(); // the owner is still running
      await owner.stop();
    });

    it('is refused when it rejects the credentials, with a message that says what to change', async () => {
      const options = await newOptions();
      await start(options);

      await assert.rejects(
        () => startEmbeddedPostgres({ ...options, dataDir: path.join(path.dirname(options.dataDir), 'other'), password: 'other-password' }),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddedDatabaseError);
          assert.match(error.message, new RegExp(`port ${options.port}`));
          assert.match(error.message, /rejected the user "postgres"/);
          assert.match(error.message, /DB_PORT/);
          assert.match(error.message, /DB_PASSWORD/);
          return true;
        }
      );
    });
  });

  it('refuses a port that another program is using, and says how to choose another', async () => {
    const options = await newOptions();
    const sockets = new Set<net.Socket>();
    const other = net.createServer(socket => { sockets.add(socket); socket.end(); });
    await new Promise<void>(resolve => other.listen(options.port, '127.0.0.1', resolve));
    try {
      await assert.rejects(() => startEmbeddedPostgres(options), (error: unknown) => {
        assert.ok(error instanceof EmbeddedDatabaseError);
        assert.match(error.message, new RegExp(`Port ${options.port} is already used by another program`));
        assert.match(error.message, /DB_PORT/);
        return true;
      });
    } finally {
      for (const socket of sockets) socket.destroy(); // close() would wait for them
      await new Promise<void>(resolve => other.close(() => resolve()));
    }
    assert.equal(existsSync(options.dataDir), false, 'nothing was created');
  });

  it('explains why it cannot start when the data folder cannot be created', async () => {
    const options = await newOptions();
    writeFileSync(options.dataDir, 'this is a file, not a folder');

    await assert.rejects(() => startEmbeddedPostgres(options), (error: unknown) => {
      assert.ok(error instanceof EmbeddedDatabaseError);
      assert.match(error.message, new RegExp(`Could not start the embedded PostgreSQL on port ${options.port}`));
      return true;
    });
    await assertNothingListens(options);
  });
});
