import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { EmbeddedDatabaseError, removeFolder, stopEmbeddedPostgres } from './embedded-postgres';

// `npm run db:stop` and `npm run db:reset`, for the rare cases where the local database must be stopped by
// hand (left running by a run that was killed), or its data deleted. The same on every system.

export async function stopLocalDatabase(dataDir: string): Promise<string> {
  return (await stopEmbeddedPostgres(dataDir)) ? `Local database stopped (${dataDir}).` : 'No local database is running.';
}

export async function resetLocalDatabase(dataDir: string): Promise<string> {
  await stopEmbeddedPostgres(dataDir);
  if (!existsSync(dataDir)) return `There is no local database to delete (${dataDir} does not exist).`;
  // Whatever DB_DATA_DIR says, only a PostgreSQL data folder is ever deleted.
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    throw new EmbeddedDatabaseError(`${dataDir} is not a PostgreSQL data folder: nothing was deleted.`);
  }
  await removeFolder(dataDir);
  await removeFolder(`${dataDir}.initdb`);
  await removeFolder(`${dataDir}.password`);
  return `Local database deleted (${dataDir}): the next npm run dev creates an empty one.`;
}

async function main(command: string | undefined): Promise<string> {
  if (!config.embedded.enabled) return 'DB_EMBEDDED=false: this project does not run the database, so there is nothing to do.';
  if (command === 'stop') return stopLocalDatabase(config.embedded.dataDir);
  if (command === 'reset') return resetLocalDatabase(config.embedded.dataDir);
  throw new Error('Usage: ts-node src/database-cli.ts stop|reset');
}

if (require.main === module) {
  main(process.argv[2]).then(
    message => console.log(message),
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
