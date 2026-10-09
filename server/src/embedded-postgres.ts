import { execFileSync } from "node:child_process";
import { access, chown, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { quoteIdent } from "./sql-safety";

// Starts a real PostgreSQL server that lives inside the project (binaries installed by npm, data in a
// local folder): nothing to install, no container. It only listens on the local machine.

export interface EmbeddedDatabaseOptions {
  dataDir: string;
  port: number;
  user: string;
  password: string;
  /** Created if it does not exist yet. */
  database: string;
}

export interface EmbeddedDatabase {
  /**
   * - "started": this call launched the server.
   * - "adopted": our own server, left running by a previous run that did not shut down (terminal closed,
   *   kill -9): it is taken over, and stopped by stop().
   * - "external": another PostgreSQL accepted our credentials on that port: used as is, never stopped.
   */
  source: "started" | "adopted" | "external";
  /** Stops the server, unless it is "external". */
  stop(): Promise<void>;
}

export class EmbeddedDatabaseError extends Error {}

interface Cluster {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// embedded-postgres is an ES module and this project is compiled to CommonJS: a plain import()
// would be rewritten by TypeScript into require(), which cannot load it.
const importModule = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<{ default: new (options: Record<string, unknown>) => Cluster }>;

const LOOPBACK = "127.0.0.1";

type Probe = "free" | "reusable" | "rejects-credentials" | "busy";

// Is something already listening on the port, and is it a PostgreSQL we can use?
async function probe({ port, user, password }: EmbeddedDatabaseOptions): Promise<Probe> {
  const client = new pg.Client({ host: LOOPBACK, port, user, password, database: "postgres", connectionTimeoutMillis: 3000 });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.end();
    return "reusable";
  } catch (error: any) {
    await client.end().catch(() => {});
    if (error?.code === "ECONNREFUSED") return "free";
    if (error?.code === "28P01" || error?.code === "28000") return "rejects-credentials";
    return "busy";
  }
}

async function ensureDatabase({ port, user, password, database }: EmbeddedDatabaseOptions): Promise<void> {
  const client = new pg.Client({ host: LOOPBACK, port, user, password, database: "postgres" });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!rowCount) await client.query(`CREATE DATABASE ${quoteIdent(database)}`);
  } finally {
    await client.end();
  }
}

const exists = (file: string) => access(file).then(() => true, () => false);

// The first lines of postmaster.pid are: pid, data directory, start time, port.
// It tells whether the server answering on the port is the one that owns our data directory.
async function ownRunningServer({ dataDir, port }: EmbeddedDatabaseOptions): Promise<number | undefined> {
  try {
    const [pid, directory, , listeningPort] = (await readFile(path.join(dataDir, "postmaster.pid"), "utf8")).split("\n");
    if (path.resolve(directory) !== path.resolve(dataDir) || Number(listeningPort) !== port) return undefined;
    process.kill(Number(pid), 0); // throws when the process is gone (stale file)
    return Number(pid);
  } catch {
    return undefined;
  }
}

// PostgreSQL treats SIGINT as a "fast shutdown": it disconnects clients and exits cleanly.
async function stopServer(pid: number, timeoutMs = 15000): Promise<void> {
  try {
    process.kill(pid, "SIGINT");
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new EmbeddedDatabaseError(`The embedded PostgreSQL (pid ${pid}) did not stop within ${timeoutMs / 1000} seconds.`);
}

// PostgreSQL refuses to run as root. When the server itself runs as root (containers, shared servers),
// embedded-postgres runs it as the "postgres" system user, which must then own the data directory.
async function prepareDataDirForRoot(dataDir: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  try {
    const uid = Number(execFileSync("id", ["-u", "postgres"]).toString());
    const gid = Number(execFileSync("id", ["-g", "postgres"]).toString());
    await mkdir(dataDir, { recursive: true });
    await chown(dataDir, uid, gid);
  } catch {
    // No "postgres" system user: embedded-postgres reports it, with an explanation.
  }
}

function explainStartFailure(error: unknown, log: string[], { port }: EmbeddedDatabaseOptions): string {
  const reason = error instanceof Error ? error.message : "";
  const details = log.filter(line => /FATAL|ERROR|could not|cannot/i.test(line)).slice(-3).join(" | ");
  let message = `Could not start the embedded PostgreSQL on port ${port}`;
  if (reason) message += `: ${reason}`;
  else if (details) message += `: ${details}`;
  if (/root/i.test(reason)) {
    message += " PostgreSQL cannot run as root: run the server as a normal user, or set DB_EMBEDDED=false to use your own PostgreSQL.";
  }
  return message;
}

export async function startEmbeddedPostgres(options: EmbeddedDatabaseOptions): Promise<EmbeddedDatabase> {
  const state = await probe(options);

  if (state === "rejects-credentials") {
    throw new EmbeddedDatabaseError(
      `A PostgreSQL server is already listening on port ${options.port} but rejected the user "${options.user}" ` +
        "and its password. Choose a free port with DB_PORT, or fix DB_USER and DB_PASSWORD."
    );
  }
  if (state === "busy") {
    throw new EmbeddedDatabaseError(`Port ${options.port} is already used by another program. Choose a free port with DB_PORT.`);
  }
  if (state === "reusable") {
    await ensureDatabase(options);
    const pid = await ownRunningServer(options);
    return pid === undefined
      ? { source: "external", stop: async () => {} }
      : { source: "adopted", stop: () => stopServer(pid) };
  }

  const log: string[] = [];
  const remember = (message: unknown) => {
    for (const line of String(message).split("\n")) {
      if (line.trim()) log.push(line.trim());
    }
    log.splice(0, Math.max(0, log.length - 50));
  };

  let cluster: Cluster;
  try {
    const { default: EmbeddedPostgres } = await importModule("embedded-postgres");
    cluster = new EmbeddedPostgres({
      databaseDir: options.dataDir,
      port: options.port,
      user: options.user,
      password: options.password,
      authMethod: "scram-sha-256",
      persistent: true,
      onLog: remember,
      onError: remember,
    });
    await mkdir(path.dirname(options.dataDir), { recursive: true });
    if (!(await exists(path.join(options.dataDir, "PG_VERSION")))) {
      await prepareDataDirForRoot(options.dataDir);
      await cluster.initialise();
    }
    await cluster.start();
  } catch (error) {
    throw new EmbeddedDatabaseError(explainStartFailure(error, log, options));
  }

  try {
    await ensureDatabase(options);
  } catch (error) {
    await cluster.stop().catch(() => {});
    throw error;
  }
  return { source: "started", stop: () => cluster.stop() };
}
