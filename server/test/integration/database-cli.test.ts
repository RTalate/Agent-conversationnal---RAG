import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { resetLocalDatabase, stopLocalDatabase } from '../../src/database-cli';
import { EmbeddedDatabaseError, startEmbeddedPostgres, type EmbeddedDatabase } from '../../src/embedded-postgres';
import { freePort, tempDir, TEST_DB_PASSWORD, TEST_DB_USER } from '../helpers/harness';

// npm run db:stop and npm run db:reset.

const SERVER_DIR = path.resolve(__dirname, '../..');

describe('the database commands', () => {
  const running: EmbeddedDatabase[] = [];
  const folders: string[] = [];

  async function startDatabase() {
    const root = await tempDir('sqlgen-cli-test-');
    folders.push(root);
    const options = { dataDir: path.join(root, 'pg'), port: await freePort(), user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: 'app' };
    running.push(await startEmbeddedPostgres(options));
    return options;
  }

  const connect = async (port: number) => {
    const client = new Client({ host: '127.0.0.1', port, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: 'app' });
    await client.connect();
    return client;
  };

  afterEach(async () => {
    for (const database of running.splice(0)) await database.stop().catch(() => {});
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  });

  it('db:stop stops the running database and keeps its data', async () => {
    const { dataDir, port } = await startDatabase();

    assert.equal(await stopLocalDatabase(dataDir), `Local database stopped (${dataDir}).`);

    await assert.rejects(() => connect(port), { code: 'ECONNREFUSED' });
    assert.ok(existsSync(path.join(dataDir, 'PG_VERSION')));
    assert.equal(await stopLocalDatabase(dataDir), 'No local database is running.');
  });

  it('db:reset stops the database and deletes its data folder', async () => {
    const { dataDir, port } = await startDatabase();

    assert.match(await resetLocalDatabase(dataDir), /^Local database deleted/);

    await assert.rejects(() => connect(port), { code: 'ECONNREFUSED' });
    assert.equal(existsSync(dataDir), false);
  });

  it('db:reset deletes nothing that is not a PostgreSQL data folder', async () => {
    const root = await tempDir('sqlgen-cli-test-');
    folders.push(root);
    const precious = path.join(root, 'documents');
    mkdirSync(precious);
    writeFileSync(path.join(precious, 'report.txt'), 'keep me');

    await assert.rejects(() => resetLocalDatabase(precious), (error: unknown) => {
      assert.ok(error instanceof EmbeddedDatabaseError);
      assert.match(error.message, /is not a PostgreSQL data folder: nothing was deleted/);
      return true;
    });
    assert.ok(existsSync(path.join(precious, 'report.txt')));
  });

  it('db:reset says when there is nothing to delete', async () => {
    const missing = path.join(await tempDir('sqlgen-cli-test-'), 'pg');
    folders.push(path.dirname(missing));

    assert.match(await resetLocalDatabase(missing), /There is no local database to delete/);
  });

  it('npm run db:stop uses the data folder of the configuration', async () => {
    const { dataDir, port } = await startDatabase();

    const { stdout } = await promisify(execFile)(process.execPath, ['--require', 'ts-node/register', 'src/database-cli.ts', 'stop'], {
      cwd: SERVER_DIR,
      env: { ...process.env, DB_EMBEDDED: '', DB_DATA_DIR: dataDir },
    });

    assert.equal(stdout.trim(), `Local database stopped (${dataDir}).`);
    await assert.rejects(() => connect(port), { code: 'ECONNREFUSED' });
  });
});
