import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness';

// PostgreSQL can close the connections of an idle pool (it is restarted, stopped, or an administrator
// ends the sessions). The `pg` library reports it as an "error" event on the pool, and a process
// with no listener for it crashes: the server must survive and reconnect.

describe('the database connections of the server', () => {
  let h: Harness;
  let query: (sql: string) => Promise<{ rows: any[] }>;
  let queryReadOnly: (sql: string) => Promise<{ rows: any[] }>;

  before(async () => {
    h = await startHarness();
    ({ query, queryReadOnly } = await import('../../src/db'));
  });
  after(() => h.stop());

  it('survive the server ending them while idle, and reconnect for the next query', async () => {
    let crash: unknown;
    const onCrash = (error: unknown) => { crash = error; };
    process.on('uncaughtException', onCrash);
    try {
      await query('SELECT 1'); // leaves an idle connection in the pool
      await queryReadOnly('SELECT 1');
      const [{ pid }] = await h.sql('SELECT pg_backend_pid() AS pid');

      const ended = await h.sql(
        'SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1) ended',
        [pid]
      );
      assert.ok(ended[0].n >= 1, 'the pool had connections to end');
      await new Promise(resolve => setTimeout(resolve, 500)); // the event arrives asynchronously

      assert.equal(crash, undefined, `the process crashed: ${(crash as Error | undefined)?.message}`);
      assert.deepEqual((await query('SELECT 1 AS ok')).rows, [{ ok: 1 }]);
      assert.deepEqual((await queryReadOnly('SELECT 2 AS ok')).rows, [{ ok: 2 }]);
    } finally {
      process.off('uncaughtException', onCrash);
    }
  });
});
