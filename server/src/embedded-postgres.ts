import { execFileSync, spawn } from "node:child_process";
import { access, chown, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { quoteIdent } from "./sql-safety";

// Runs a real PostgreSQL server that lives inside the project: its programs come from npm (one
// @embedded-postgres/<system> package per operating system and processor), its data from a local folder.
// Nothing to install, no container. It only listens on the local machine.
//
// It is started and stopped with pg_ctl, PostgreSQL's own tool, on every system: pg_ctl waits until the
// server accepts connections, stops it cleanly (also on Windows, which has no signals), and on Windows
// drops administrator rights, which PostgreSQL refuses.

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

/** Where the server writes its messages, in its data folder. */
export const LOG_FILE = "postgres.log";

// The npm package that holds the PostgreSQL programs for each system (`${process.platform}-${process.arch}`).
const PACKAGES: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm": "linux-arm",
  "linux-arm64": "linux-arm64",
  "linux-ia32": "linux-ia32",
  "linux-ppc64": "linux-ppc64",
  "linux-x64": "linux-x64",
  "win32-x64": "windows-x64",
};

interface Programs {
  initdb: string;
  pgCtl: string;
}

export function findPrograms(platform: string = process.platform, arch: string = process.arch): Programs {
  const name = PACKAGES[`${platform}-${arch}`];
  if (!name) {
    throw new EmbeddedDatabaseError(
      `There is no embedded PostgreSQL for this system (${platform} ${arch}). ` +
        "Set DB_EMBEDDED=false in server/.env and use your own PostgreSQL (see the README)."
    );
  }
  let entry: string;
  try {
    entry = require.resolve(`@embedded-postgres/${name}`);
  } catch {
    throw new EmbeddedDatabaseError(
      `The PostgreSQL programs for this system (@embedded-postgres/${name}) are not installed. ` +
        "Install the dependencies again: npm run setup at the root of the project."
    );
  }
  const bin = path.join(path.dirname(entry), "..", "native", "bin");
  const extension = platform === "win32" ? ".exe" : "";
  return { initdb: path.join(bin, `initdb${extension}`), pgCtl: path.join(bin, `pg_ctl${extension}`) };
}

// PostgreSQL refuses to run as root. When the server itself runs as root (containers, shared servers),
// PostgreSQL runs as the "postgres" system user, which must then own the data folder.
interface RunAs {
  uid?: number;
  gid?: number;
}

function systemUser(): RunAs {
  if (process.getuid?.() !== 0) return {};
  try {
    return {
      uid: Number(execFileSync("id", ["-u", "postgres"]).toString()),
      gid: Number(execFileSync("id", ["-g", "postgres"]).toString()),
    };
  } catch {
    throw new EmbeddedDatabaseError(
      "PostgreSQL cannot run as root: run the server as a normal user, or set DB_EMBEDDED=false to use your own PostgreSQL."
    );
  }
}

interface Result {
  code: number | null;
  output: string;
}

// Windows reports a missing DLL (here, the Microsoft Visual C++ runtime) with this exit status.
const DLL_NOT_FOUND = [0xc0000135, -1073741515];

function run(program: string, args: string[], runAs: RunAs): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      ...runAs,
      env: { ...process.env, LC_MESSAGES: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", chunk => (output += chunk));
    child.stderr.on("data", chunk => (output += chunk));
    child.once("error", reject);
    // Not "close": on Windows, the server started by `pg_ctl start` inherits the output pipes and keeps
    // them open as long as it runs. Its own messages go to the log file, so nothing is lost.
    child.once("exit", code => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, output });
      }, 50);
    });
  });
}

/** A PostgreSQL program failed while starting: its exit code and what it printed. */
export class StartFailure extends Error {
  constructor(readonly code: number | null, readonly details: string) {
    super(details);
  }
}

// initdb works in a separate folder that is renamed once complete: a first start interrupted halfway
// (Ctrl-C, window closed) never leaves a half-created data folder behind, only this one, deleted next time.
async function initialise(programs: Programs, runAs: RunAs, { dataDir, user, password }: EmbeddedDatabaseOptions) {
  // Never build over something else: a file, or a folder that already holds other things.
  const existing = await stat(dataDir).catch(() => undefined);
  if (existing && (!existing.isDirectory() || (await readdir(dataDir)).length > 0)) {
    throw new Error(`${dataDir} already exists and is not a PostgreSQL data folder: nothing was changed. Choose another folder with DB_DATA_DIR.`);
  }
  const staging = `${dataDir}.initdb`;
  await removeFolder(staging);
  if (runAs.uid !== undefined) {
    await mkdir(staging);
    await chown(staging, runAs.uid, runAs.gid!);
  }
  // initdb reads the password from a file, readable by its owner only, deleted right after. It sits next to
  // the data folder rather than in the system's temporary folder, so that one left by an interrupted start
  // is not left there: the next start deletes it.
  const passwordFile = `${dataDir}.password`;
  await rm(passwordFile, { force: true });
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  try {
    if (runAs.uid !== undefined) await chown(passwordFile, runAs.uid, runAs.gid!);
    const { code, output } = await run(
      programs.initdb,
      [
        "-D", staging,
        `--username=${user}`,
        `--pwfile=${passwordFile}`,
        "--auth=scram-sha-256",
        // The same text handling on every system: UTF-8, and Unicode-aware upper/lower case (ILIKE
        // 'été' finds 'Été'). Without it, Windows would pick its own code page (WIN1252), which rejects
        // most non-Latin characters of an imported CSV.
        "--encoding=UTF8",
        "--locale=C",
        "--locale-provider=builtin",
        "--builtin-locale=C.UTF-8",
      ],
      runAs
    );
    if (code !== 0) throw new StartFailure(code, output);
  } finally {
    await rm(passwordFile, { force: true });
  }
  await rmdir(dataDir).catch(() => {}); // an empty folder is in the way of the rename on Windows
  await renamePatiently(staging, dataDir);
}

// On Windows, an antivirus scanning the files initdb just wrote briefly prevents renaming their folder.
async function renamePatiently(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error: any) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 50) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/** Deletes a folder; on Windows, files still held for a moment (antivirus, a process exiting) are retried. */
export const removeFolder = (folder: string) => rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

async function fileSize(file: string): Promise<number> {
  return stat(file).then(info => info.size, () => 0);
}

/** What the server wrote to its log file after `offset`. */
async function readLogFrom(file: string, offset: number): Promise<string> {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.max(0, size - offset));
      await handle.read(buffer, 0, buffer.length, offset);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function startServer(programs: Programs, runAs: RunAs, { dataDir, port }: EmbeddedDatabaseOptions) {
  // The lock file of a server that was killed still says "ready". On Windows, pg_ctl takes it for the new
  // server's when both started within two seconds, and returns too early. No process runs from it: it goes.
  const lock = await readPidFile(dataDir);
  if (lock && !isAlive(lock.pid)) await rm(path.join(dataDir, "postmaster.pid"), { force: true });

  const logFile = path.join(dataDir, LOG_FILE);
  const offset = await fileSize(logFile);
  const { code, output } = await run(
    programs.pgCtl,
    ["start", "-D", dataDir, "-l", logFile, "-w", "-t", "60", "-o", `-p ${port} -c listen_addresses=localhost`],
    runAs
  );
  if (code !== 0) throw new StartFailure(code, `${output}\n${await readLogFrom(logFile, offset)}`);
}

export function explainStartFailure(error: unknown, { port }: Pick<EmbeddedDatabaseOptions, "port">): string {
  if (error instanceof EmbeddedDatabaseError) return error.message;
  const prefix = `Could not start the embedded PostgreSQL on port ${port}`;
  if (!(error instanceof StartFailure)) return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;

  if (error.code !== null && DLL_NOT_FOUND.includes(error.code)) {
    return (
      `${prefix}: the Microsoft Visual C++ Redistributable (x64) is missing. ` +
      "Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then start again."
    );
  }
  if (/could not create any TCP\/IP sockets|could not bind/i.test(error.details)) {
    return `Port ${port} is already used by another program. Choose a free port with DB_PORT.`;
  }
  if (/administrative permissions/i.test(error.details)) {
    return `${prefix}: PostgreSQL refuses to run with administrator rights. Open a terminal without "Run as administrator".`;
  }
  const lines = error.details
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /FATAL|PANIC|ERROR|error:|could not|cannot/i.test(line));
  return lines.length ? `${prefix}: ${lines.slice(-3).join(" | ")}` : `${prefix} (exit code ${error.code}).`;
}

type Probe = "free" | "reusable" | "rejects-credentials" | "busy";

const LOOPBACK = "127.0.0.1";

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
  const client = await connectWhenReady({ port, user, password });
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!rowCount) await client.query(`CREATE DATABASE ${quoteIdent(database)}`);
  } finally {
    await client.end();
  }
}

// A server pg_ctl reports as started may still refuse connections, or answer that it is starting up
// (57P03), for a moment.
async function connectWhenReady({ port, user, password }: Pick<EmbeddedDatabaseOptions, "port" | "user" | "password">) {
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client({ host: LOOPBACK, port, user, password, database: "postgres" });
    try {
      await client.connect();
      return client;
    } catch (error: any) {
      await client.end().catch(() => {});
      if (attempt >= 50 || !["ECONNREFUSED", "57P03"].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

const exists = (file: string) => access(file).then(() => true, () => false);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0); // checks that the process exists, sends nothing
    return true;
  } catch (error: any) {
    return error?.code === "EPERM"; // it exists, but belongs to another user
  }
};

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

// The first lines of postmaster.pid are: pid, data folder, start time, port. On Windows, the folder is
// written with forward slashes and the lines may end with \r\n.
interface PidFile {
  pid: number;
  dataDir: string;
  port: number;
}

async function readPidFile(dataDir: string): Promise<PidFile | undefined> {
  try {
    const [pid, directory, , port] = (await readFile(path.join(dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/);
    return { pid: Number(pid), dataDir: directory.trim(), port: Number(port) };
  } catch {
    return undefined;
  }
}

/** The pid of the server that owns `dataDir`, if it is running (a stale postmaster.pid is ignored). */
async function runningServer(dataDir: string): Promise<PidFile | undefined> {
  const file = await readPidFile(dataDir);
  if (!file || !samePath(file.dataDir, dataDir) || !isAlive(file.pid)) return undefined;
  return file;
}

// A fast shutdown: PostgreSQL disconnects the clients and exits cleanly.
async function stopServer(dataDir: string): Promise<void> {
  const { code, output } = await run(findPrograms().pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"], systemUser());
  // pg_ctl also fails when there is nothing to stop (already stopped, or a stale postmaster.pid).
  if (code !== 0 && (await runningServer(dataDir))) {
    throw new EmbeddedDatabaseError(`Could not stop the embedded PostgreSQL: ${output.trim()}`);
  }
}

/** Stops the server that owns `dataDir`, if one is running. Returns whether there was one. */
export async function stopEmbeddedPostgres(dataDir: string): Promise<boolean> {
  if (!(await runningServer(dataDir))) return false;
  await stopServer(dataDir);
  return true;
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
    const own = await runningServer(options.dataDir);
    return own && own.port === options.port
      ? { source: "adopted", stop: () => stopServer(options.dataDir) }
      : { source: "external", stop: async () => {} };
  }

  try {
    const programs = findPrograms();
    const runAs = systemUser();
    await mkdir(path.dirname(options.dataDir), { recursive: true });
    if (!(await exists(path.join(options.dataDir, "PG_VERSION")))) await initialise(programs, runAs, options);
    await startServer(programs, runAs, options);
  } catch (error) {
    throw new EmbeddedDatabaseError(explainStartFailure(error, options));
  }

  const stop = () => stopServer(options.dataDir);
  try {
    await ensureDatabase(options);
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return { source: "started", stop };
}
