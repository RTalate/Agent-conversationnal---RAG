import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertLlmConfigured, ConfigError, loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('works with nothing set except what has no default: the database is local and embedded', () => {
    const config = loadConfig({});

    assert.deepEqual(config.db, {
      host: '127.0.0.1', port: 54329, name: 'sqlgen', user: 'postgres', password: 'admin',
      readOnlyUser: undefined, readOnlyPassword: undefined,
    });
    assert.equal(config.embedded.enabled, true);
    assert.ok(path.isAbsolute(config.embedded.dataDir));
    assert.match(config.embedded.dataDir, /server[\\/]\.data[\\/]postgres$/);
    assert.equal(config.server.port, 3000);
  });

  it('reaches OpenRouter by default, with a model that can be changed', () => {
    const { llm } = loadConfig({});
    assert.equal(llm.baseURL, 'https://openrouter.ai/api/v1');
    assert.equal(llm.model, 'openai/gpt-4o-mini');
    assert.equal(llm.jsonMode, true);
    assert.equal(llm.apiKey, '');
  });

  it('reads every setting', () => {
    const config = loadConfig({
      PORT: '4000', DB_HOST: 'db.internal', DB_PORT: '5432', DB_NAME: 'mydb', DB_USER: 'me', DB_PASSWORD: 'secret',
      DB_READONLY_USER: 'reader', DB_READONLY_PASSWORD: 'readonly-secret', DB_EMBEDDED: 'false', DB_DATA_DIR: '/data/pg',
      OPENROUTER_API_KEY: 'sk-or-123', LLM_MODEL: 'anthropic/claude-sonnet-4.5', LLM_BASE_URL: 'http://gateway.internal/v1',
      LLM_JSON_MODE: 'false',
    });

    assert.equal(config.server.port, 4000);
    assert.deepEqual(config.db, {
      host: 'db.internal', port: 5432, name: 'mydb', user: 'me', password: 'secret',
      readOnlyUser: 'reader', readOnlyPassword: 'readonly-secret',
    });
    assert.deepEqual(config.embedded, { enabled: false, dataDir: path.resolve('/data/pg') });
    assert.deepEqual(config.llm, {
      apiKey: 'sk-or-123', baseURL: 'http://gateway.internal/v1', model: 'anthropic/claude-sonnet-4.5',
      jsonMode: false, legacyKeyPresent: false,
    });
  });

  it('treats empty and blank values as not set, and trims the others', () => {
    const config = loadConfig({ DB_HOST: '', DB_USER: '   ', LLM_MODEL: '', OPENROUTER_API_KEY: '  sk-or-1  ', DB_READONLY_USER: ' ' });
    assert.equal(config.db.host, '127.0.0.1');
    assert.equal(config.db.user, 'postgres');
    assert.equal(config.llm.model, 'openai/gpt-4o-mini');
    assert.equal(config.llm.apiKey, 'sk-or-1');
    assert.equal(config.db.readOnlyUser, undefined);
  });

  for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
    it(`reads DB_EMBEDDED=${value} as off`, () => {
      assert.equal(loadConfig({ DB_EMBEDDED: value }).embedded.enabled, false);
    });
  }
  for (const value of ['true', '1', 'yes', 'on', 'anything']) {
    it(`reads DB_EMBEDDED=${value} as on`, () => {
      assert.equal(loadConfig({ DB_EMBEDDED: value }).embedded.enabled, true);
    });
  }

  for (const [name, value] of [['DB_PORT', 'abc'], ['DB_PORT', '0'], ['DB_PORT', '70000'], ['DB_PORT', '54.5'], ['PORT', '-1']]) {
    it(`rejects ${name}=${value}`, () => {
      assert.throws(() => loadConfig({ [name]: value }), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(name));
        return true;
      });
    });
  }

  it('rejects an LLM_BASE_URL that is not a URL', () => {
    assert.throws(() => loadConfig({ LLM_BASE_URL: 'openrouter' }), /LLM_BASE_URL must be a URL/);
  });
});

describe('assertLlmConfigured', () => {
  it('passes when a key is set', () => {
    assert.doesNotThrow(() => assertLlmConfigured(loadConfig({ OPENROUTER_API_KEY: 'sk-or-1' }).llm));
  });

  it('tells where to get a key when there is none', () => {
    assert.throws(() => assertLlmConfigured(loadConfig({}).llm), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /OPENROUTER_API_KEY is not set/);
      assert.match(error.message, /openrouter\.ai\/keys/);
      assert.doesNotMatch(error.message, /OPENAI_API_KEY/);
      return true;
    });
  });

  it('explains that the former OPENAI_API_KEY is no longer read', () => {
    assert.throws(() => assertLlmConfigured(loadConfig({ OPENAI_API_KEY: 'sk-old' }).llm), /OPENAI_API_KEY is no longer read/);
  });

  it('does not accept a blank key', () => {
    assert.throws(() => assertLlmConfigured(loadConfig({ OPENROUTER_API_KEY: '   ' }).llm), ConfigError);
  });
});
