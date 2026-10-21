// Every command of the project, the same on Windows, macOS and Linux. They are run through npm at the root
// of the project (npm run dev, npm test...): see "Commandes" in the README, or run this file without
// arguments for the list.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const UI = path.join(ROOT, 'ui');
const WINDOWS = process.platform === 'win32';
// Node.js 18.18 is the oldest version the tools of the project support (Vite, Vitest, ESLint, the OpenAI SDK).
// The test suites need 22: before it, the test runner has no --test-timeout, does not expand file patterns, and
// runs the beforeEach hooks of a parent describe() only once for a nested one.
const NODE_MINIMUM = [18, 18];
const NODE_FOR_TESTS = 22;

class CommandError extends Error {}

const relative = dir => path.relative(ROOT, dir) || '.';

// --- Running programs ------------------------------------------------------------------------------------

/** Runs a program with the terminal as its output, and resolves with its exit code. */
function run(program, args, { cwd = ROOT, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    // With a shell, the command is given as one string: the arguments here are fixed words.
    const child = shell
      ? spawn([program, ...args].join(' '), { cwd, stdio: 'inherit', shell: true })
      : spawn(program, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** npm itself. Through `npm run`, npm gives the path of its own script; otherwise "npm", which on Windows
 * is a npm.cmd file that only a shell can start. */
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli)) return run(process.execPath, [cli, ...args], { cwd });
  return run('npm', args, { cwd, shell: WINDOWS });
}

async function mustSucceed(description, exitCode) {
  if ((await exitCode) !== 0) throw new CommandError(`${description} failed.`);
}

// --- Dependencies ----------------------------------------------------------------------------------------

// npm writes node_modules/.package-lock.json at the end of each installation: the dependencies are up to date
// when it is more recent than package-lock.json (which `git pull` changes when they change).
function needsInstall(dir) {
  const installed = path.join(dir, 'node_modules', '.package-lock.json');
  return !existsSync(installed) || statSync(path.join(dir, 'package-lock.json')).mtimeMs > statSync(installed).mtimeMs;
}

async function install(dirs, { always = false } = {}) {
  for (const dir of dirs) {
    if (!always && !needsInstall(dir)) continue;
    console.log(`Installing the dependencies of ${relative(dir)}/ (npm ci)...`);
    await mustSucceed(`Installing the dependencies of ${relative(dir)}/`, npm(['ci'], dir));
  }
}

// --- Steps -----------------------------------------------------------------------------------------------

const npmStep = (dir, script) => ({ dirs: [dir], run: () => npm(['run', script], dir) });

const STEPS = {
  'test:unit': npmStep(SERVER, 'test:unit'),
  'test:integration': npmStep(SERVER, 'test:integration'),
  'test:ui': npmStep(UI, 'test'),
  'test:scripts': { dirs: [SERVER, UI], run: () => run(process.execPath, ['--test', '--test-timeout=600000', 'scripts/test/*.test.mjs']) },
  'typecheck:server': npmStep(SERVER, 'typecheck'),
  'typecheck:ui': npmStep(UI, 'typecheck'),
  lint: npmStep(UI, 'lint'),
  'build:server': npmStep(SERVER, 'build'),
  'build:ui': npmStep(UI, 'build'),
  'db:stop': npmStep(SERVER, 'db:stop'),
  'db:reset': npmStep(SERVER, 'db:reset'),
};

const TESTS = ['test:unit', 'test:integration', 'test:ui', 'test:scripts'];
const CHECKS = ['typecheck:server', 'typecheck:ui', 'lint', 'build:server', 'build:ui'];

/** Runs the steps one after the other, and stops at the first that fails. */
async function sequence(names) {
  await install([...new Set(names.flatMap(name => STEPS[name].dirs))]);
  for (const name of names) await mustSucceed(name, STEPS[name].run());
}

/** Runs every step, even after a failure, so that one failing suite does not hide the others. */
async function all(names) {
  await install([...new Set(names.flatMap(name => STEPS[name].dirs))]);
  const failed = [];
  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    if ((await STEPS[name].run()) !== 0) failed.push(name);
  }
  console.log(`\n${names.map(name => `${failed.includes(name) ? 'FAILED' : 'passed'}  ${name}`).join('\n')}`);
  if (failed.length) throw new CommandError(`${failed.length} of ${names.length} failed: ${failed.join(', ')}.`);
}

async function clean() {
  const targets = [path.join(SERVER, 'dist'), path.join(UI, 'dist')];
  for (const file of readdirSync(UI)) if (file.endsWith('.tsbuildinfo')) targets.push(path.join(UI, file));
  for (const target of targets) await rm(target, { recursive: true, force: true });
  console.log('Build output removed.');
}

// --- npm run dev -----------------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g;

/** Copies the output of a child line by line, each line marked with the name of the program. */
function relay(child, label, onLine) {
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
      target.write(`${label} ${line}\n`);
      onLine(line.replace(ANSI, ''));
    });
  }
}

// Starts the API, which runs its own PostgreSQL, then the interface once the API is ready. Ctrl-C stops
// everything, and so does either of them stopping on its own (the API failing to start, for example), so
// that a failed start is never left half-running.
//
// The API is asked to stop through a message channel rather than a signal: Windows has no signals.
async function dev() {
  if (!existsSync(path.join(SERVER, '.env')) && !process.env.OPENROUTER_API_KEY) {
    throw new CommandError('server/.env is missing. Create it with: cp server/.env.sample server/.env (then set OPENROUTER_API_KEY in it)');
  }
  await install([SERVER, UI]);

  const uiPort = process.env.UI_PORT || '5173';
  // Colors survive the relay when the terminal shows them.
  const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: '1' } : process.env;

  return new Promise(resolve => {
    let exitCode = 0;
    let stopping = false;
    let ui;

    const api = spawn(process.execPath, ['--require', 'ts-node/register', 'src/index.ts'], {
      cwd: SERVER,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    api.on('error', () => {}); // a message sent while it exits
    const running = [api];

    const stop = code => {
      if (stopping) return;
      stopping = true;
      exitCode = code;
      if (api.connected) api.send('shutdown');
      if (ui && ui.exitCode === null) ui.kill();
      // Whatever has not stopped after 30 seconds is ended outright.
      setTimeout(() => running.forEach(child => child.exitCode === null && child.kill('SIGKILL')), 30_000).unref();
    };

    const exited = child => {
      running.splice(running.indexOf(child), 1);
      if (!running.length) resolve(exitCode);
    };

    relay(api, '[api]', line => {
      const ready = /Server running on port (\d+)/.exec(line);
      if (!ready || ui || stopping) return;
      ui = spawn(process.execPath, [path.join(UI, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', uiPort, '--strictPort'], {
        cwd: UI,
        env: { VITE_API_URL: `http://127.0.0.1:${ready[1]}`, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      running.push(ui);
      relay(ui, '[ui] ', line => {
        if (/ready in/.test(line)) console.log(`\nReady: open http://localhost:${uiPort} in your browser. Ctrl-C stops everything.\n`);
      });
      ui.once('exit', code => {
        if (!stopping) {
          console.error('The interface stopped: stopping the API.');
          stop(code || 1);
        }
        exited(ui);
      });
    });

    api.once('exit', code => {
      if (!stopping) {
        console.error(ui ? 'The API stopped: stopping the interface.' : 'The API did not start: see its message above.');
        stop(code || 1);
      }
      exited(api);
    });

    // Ctrl-C and closing the terminal. On Windows they reach the API and the interface as well, which
    // stop by themselves; asking again changes nothing.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
  });
}

// --- Commands --------------------------------------------------------------------------------------------

// Commands that need Node.js 22 (see NODE_FOR_TESTS); the others run from NODE_MINIMUM.
const NEEDS_NODE_FOR_TESTS = ['test', 'test:unit', 'test:integration', 'test:scripts', 'verify'];

const COMMANDS = {
  setup: ['Install (again) the dependencies of the server and of the interface', () => install([SERVER, UI], { always: true })],
  dev: ['Start the API (3000), its database and the interface (5173); Ctrl-C stops everything', dev],
  test: ['Run all the tests', () => all(TESTS)],
  'test:unit': ['Server unit tests', () => sequence(['test:unit'])],
  'test:integration': ['Server integration tests (each one starts its own PostgreSQL)', () => sequence(['test:integration'])],
  'test:ui': ['Interface tests', () => sequence(['test:ui'])],
  'test:scripts': ['Tests of these commands (npm run dev)', () => sequence(['test:scripts'])],
  typecheck: ['Check the types of the server (code and tests) and of the interface', () => sequence(['typecheck:server', 'typecheck:ui'])],
  lint: ['Lint the interface', () => sequence(['lint'])],
  build: ['Build the server and the interface', () => sequence(['build:server', 'build:ui'])],
  check: ['Check the types, lint and build', () => sequence(CHECKS)],
  verify: ['Everything: check, then all the tests', async () => { await sequence(CHECKS); await all(TESTS); }],
  'db:stop': ['Stop the local database if a previous run left it running', () => sequence(['db:stop'])],
  'db:reset': ['Delete the local database (every imported table)', () => sequence(['db:reset'])],
  clean: ['Remove the build output', clean],
};

function usage() {
  return Object.entries(COMMANDS)
    .map(([name, [description]]) => `  npm run ${name.padEnd(17)} ${description}${NEEDS_NODE_FOR_TESTS.includes(name) ? ` (needs Node.js ${NODE_FOR_TESTS})` : ''}`)
    .join('\n');
}

async function main(name) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < NODE_MINIMUM[0] || (major === NODE_MINIMUM[0] && minor < NODE_MINIMUM[1])) {
    throw new CommandError(`Node.js ${NODE_MINIMUM.join('.')} or later is needed (this is ${process.version}). Install it from https://nodejs.org`);
  }
  if (major < NODE_FOR_TESTS && NEEDS_NODE_FOR_TESTS.includes(name)) {
    throw new CommandError(
      `npm run ${name} needs Node.js ${NODE_FOR_TESTS} or later (this is ${process.version}): the test runner of older versions cannot run the test suites.\n` +
        'Still available with this version: dev, build, typecheck, lint, check, test:ui, setup, db:stop, db:reset, clean.\n' +
        'Install Node.js 22 from https://nodejs.org to run the whole test suite.'
    );
  }
  const command = COMMANDS[name];
  if (!command) {
    console.log(`Commands:\n${usage()}`);
    return name ? 1 : 0;
  }
  return (await command[1]()) ?? 0;
}

main(process.argv[2]).then(
  code => process.exit(code),
  error => {
    console.error(error instanceof CommandError ? error.message : error);
    process.exit(1);
  }
);
