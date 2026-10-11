import type { Server } from 'node:http';
import { assertLlmConfigured, config, ConfigError } from './config';
import { closeDb, initializeTables } from './db';
import { createApp } from './app';
import { EmbeddedDatabaseError, startEmbeddedPostgres, type EmbeddedDatabase } from './embedded-postgres';

// Ctrl-C, `kill`, closing the terminal and a request from `npm run dev` stop the server, then the database
// it runs. They are listened to from the very start: a stop requested while the database is still starting
// (its first start takes a few seconds) waits for it, then stops it.
let stopping = false;
let databaseStart: Promise<EmbeddedDatabase | undefined> = Promise.resolve(undefined);
let server: Server | undefined;

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  server?.closeAllConnections();
  server?.close();
  await closeDb().catch(() => {});
  const database = await databaseStart.catch(() => undefined);
  await database?.stop().catch(() => {});
  process.exit(exitCode);
}

// SIGHUP is what closing the terminal sends. On Windows, Node turns Ctrl-C into SIGINT and closing the
// window into SIGHUP; the other signals do not exist there.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => shutdown());
// `npm run dev` (scripts/project.mjs) asks through a message channel rather than a signal, so that it
// works on Windows too. If it disappears, the server stops as well.
if (process.send) {
  process.on('message', message => message === 'shutdown' && shutdown());
  process.on('disconnect', () => shutdown());
}

async function startServer() {
  assertLlmConfigured();

  // By default the server runs its own PostgreSQL (see DB_EMBEDDED in the README).
  if (config.embedded.enabled) {
    databaseStart = startEmbeddedPostgres({
      dataDir: config.embedded.dataDir,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
    });
    const database = (await databaseStart)!;
    console.log(
      {
        started: `PostgreSQL started on port ${config.db.port} (data in ${config.embedded.dataDir})`,
        adopted: `PostgreSQL left running by a previous run taken over on port ${config.db.port} (data in ${config.embedded.dataDir})`,
        external: `Using the PostgreSQL already running on port ${config.db.port}`,
      }[database.source]
    );
  }
  if (stopping) return;

  await initializeTables();
  if (stopping) return;

  server = createApp().listen(config.server.port, config.server.host, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
  // Without this, a port already in use crashes the process and leaves the database it started running.
  server.once('error', (error: NodeJS.ErrnoException) => {
    console.error(
      'Failed to start server:',
      error.code === 'EADDRINUSE'
        ? `Port ${config.server.port} is already used by another program. Choose another one with PORT.`
        : error.message
    );
    void shutdown(1);
  });
}

startServer().catch(error => {
  if (stopping) return; // a stop was requested while starting: it is already under way
  // Configuration and database problems have an actionable message; anything else deserves its stack.
  const expected = error instanceof ConfigError || error instanceof EmbeddedDatabaseError;
  console.error('Failed to start server:', expected ? (error as Error).message : error);
  void shutdown(1);
});
