import { assertLlmConfigured, config, ConfigError } from './config';
import { closeDb, initializeTables } from './db';
import { createApp } from './app';
import { EmbeddedDatabaseError, startEmbeddedPostgres, type EmbeddedDatabase } from './embedded-postgres';

async function startServer() {
  assertLlmConfigured();

  // By default the server runs its own PostgreSQL (see DB_EMBEDDED in the README).
  let database: EmbeddedDatabase | undefined;
  if (config.embedded.enabled) {
    database = await startEmbeddedPostgres({
      dataDir: config.embedded.dataDir,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
    });
    console.log(
      {
        started: `PostgreSQL started on port ${config.db.port} (data in ${config.embedded.dataDir})`,
        adopted: `PostgreSQL left running by a previous run taken over on port ${config.db.port} (data in ${config.embedded.dataDir})`,
        external: `Using the PostgreSQL already running on port ${config.db.port}`,
      }[database.source]
    );
  }

  try {
    // Initialize database tables
    await initializeTables();
  } catch (error) {
    await closeDb().catch(() => {});
    await database?.stop().catch(() => {});
    throw error;
  }

  const server = createApp().listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });

  // Without this, a port already in use crashes the process and leaves the database it started running.
  server.once('error', async (error: NodeJS.ErrnoException) => {
    console.error(
      'Failed to start server:',
      error.code === 'EADDRINUSE'
        ? `Port ${config.server.port} is already used by another program. Choose another one with PORT.`
        : error.message
    );
    await closeDb().catch(() => {});
    await database?.stop().catch(() => {});
    process.exit(1);
  });

  // Ctrl-C, `kill` and closing the terminal stop the server, then the database it runs.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close();
    await closeDb().catch(() => {});
    await database?.stop().catch(() => {});
    process.exit(0);
  };
  // SIGHUP is what closing the terminal sends.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown);
}

// Start the server and handle any errors
startServer().catch(error => {
  // Configuration and database problems have an actionable message; anything else deserves its stack.
  const expected = error instanceof ConfigError || error instanceof EmbeddedDatabaseError;
  console.error('Failed to start server:', expected ? (error as Error).message : error);
  process.exit(1);
});
