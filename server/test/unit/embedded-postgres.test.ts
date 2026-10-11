import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EmbeddedDatabaseError, explainStartFailure, findPrograms, StartFailure } from '../../src/embedded-postgres';

// The parts of the embedded PostgreSQL that depend on the system, including messages that only Windows
// produces and that the integration tests cannot provoke elsewhere.

describe('findPrograms', () => {
  it('finds initdb and pg_ctl for this system, installed by npm', () => {
    const programs = findPrograms();

    assert.ok(existsSync(programs.initdb), programs.initdb);
    assert.ok(existsSync(programs.pgCtl), programs.pgCtl);
  });

  it('uses the .exe programs of the Windows package on Windows', () => {
    if (process.platform !== 'win32') {
      // The Windows package is not installed here: the message says how to install it.
      assert.throws(() => findPrograms('win32', 'x64'), (error: unknown) => {
        assert.ok(error instanceof EmbeddedDatabaseError);
        assert.match(error.message, /@embedded-postgres\/windows-x64\) are not installed/);
        assert.match(error.message, /npm run setup/);
        return true;
      });
      return;
    }
    const programs = findPrograms('win32', 'x64');
    assert.match(programs.initdb, /windows-x64[\\/]native[\\/]bin[\\/]initdb\.exe$/);
    assert.match(programs.pgCtl, /windows-x64[\\/]native[\\/]bin[\\/]pg_ctl\.exe$/);
  });

  for (const [platform, arch] of [['win32', 'arm64'], ['freebsd', 'x64']]) {
    it(`explains that there is no embedded PostgreSQL for ${platform} ${arch}, and what to do instead`, () => {
      assert.throws(() => findPrograms(platform, arch), (error: unknown) => {
        assert.ok(error instanceof EmbeddedDatabaseError);
        assert.match(error.message, new RegExp(`no embedded PostgreSQL for this system \\(${platform} ${arch}\\)`));
        assert.match(error.message, /DB_EMBEDDED=false/);
        return true;
      });
    });
  }
});

describe('explainStartFailure', () => {
  const port = 54329;

  for (const code of [0xc0000135, -1073741515]) {
    it(`names the missing Visual C++ Redistributable when Windows cannot load a DLL (exit code ${code})`, () => {
      const message = explainStartFailure(new StartFailure(code, ''), { port });

      assert.match(message, /^Could not start the embedded PostgreSQL on port 54329: /);
      assert.match(message, /Microsoft Visual C\+\+ Redistributable \(x64\) is missing/);
      assert.match(message, /https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
    });
  }

  it('reports a port taken between the check and the start like a port already used', () => {
    const log = [
      'LOG:  could not bind IPv4 address "127.0.0.1": Une seule utilisation de chaque adresse de socket est autorisée.',
      'FATAL:  could not create any TCP/IP sockets',
    ].join('\r\n');

    assert.equal(
      explainStartFailure(new StartFailure(1, log), { port }),
      'Port 54329 is already used by another program. Choose a free port with DB_PORT.'
    );
  });

  it('tells to leave the administrator terminal when PostgreSQL refuses administrator rights', () => {
    const output = 'Execution of PostgreSQL by a user with administrative permissions is not permitted.';

    assert.match(explainStartFailure(new StartFailure(1, output), { port }), /without "Run as administrator"/);
  });

  it('keeps the last error lines of the output', () => {
    const output = ['waiting for server to start....', 'FATAL:  one', 'some detail', 'FATAL:  two', 'initdb: error: three', 'done'].join('\n');

    assert.equal(
      explainStartFailure(new StartFailure(1, output), { port }),
      'Could not start the embedded PostgreSQL on port 54329: FATAL:  one | FATAL:  two | initdb: error: three'
    );
  });

  it('gives the exit code when the output says nothing useful', () => {
    assert.equal(
      explainStartFailure(new StartFailure(3, 'waiting for server to start.... stopped waiting'), { port }),
      'Could not start the embedded PostgreSQL on port 54329 (exit code 3).'
    );
  });

  it('keeps the message of a problem it already explained', () => {
    const error = new EmbeddedDatabaseError('PostgreSQL cannot run as root: ...');

    assert.equal(explainStartFailure(error, { port }), 'PostgreSQL cannot run as root: ...');
  });

  it('adds the reason of any other error', () => {
    const error = Object.assign(new Error("EACCES: permission denied, mkdir '/data'"), { code: 'EACCES' });

    assert.equal(
      explainStartFailure(error, { port }),
      "Could not start the embedded PostgreSQL on port 54329: EACCES: permission denied, mkdir '/data'"
    );
  });
});
