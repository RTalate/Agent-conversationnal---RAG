import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rawBody } from '../helpers/fake-openai';
import { startHarness, type Harness } from '../helpers/harness';

// How the application talks to its AI provider (OpenRouter by default, any OpenAI-compatible API in fact).

describe('calls to the AI provider (default settings)', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(() => h.stop());

  beforeEach(async () => {
    await h.reset();
    await h.sql('CREATE TABLE customers (id int, country text)');
    await h.sql("INSERT INTO customers VALUES (1, 'France'), (2, 'Spain')");
    await h.sql("INSERT INTO table_schema (table_name, analysis) VALUES ('customers', $1)", [{ id: 'Id', country: 'Country' }]);
  });

  it('posts to the chat completions endpoint of the configured base URL', async () => {
    await h.ask('How many customers are there?');

    assert.ok(h.ai.calls.length >= 5);
    for (const call of h.ai.calls) assert.equal(call.path, '/v1/chat/completions', call.step);
  });

  it('authenticates with the key as a bearer token, and names the application', async () => {
    await h.ask('How many customers are there?');

    for (const call of h.ai.calls) {
      assert.equal(call.headers?.authorization, 'Bearer test-key', call.step);
      assert.equal(call.headers?.['x-title'], 'AI SQL Query Generator', call.step);
    }
  });

  it('uses the default model, with a temperature of 0', async () => {
    await h.ask('How many customers are there?');

    for (const call of h.ai.calls) {
      assert.equal(call.model, 'openai/gpt-4o-mini', call.step);
      assert.equal(call.temperature, 0, call.step);
    }
  });

  it('asks for a JSON object on every step', async () => {
    await h.ask('How many customers are there?');

    for (const call of h.ai.calls) assert.deepEqual(call.responseFormat, { type: 'json_object' }, call.step);
  });

  describe('models that do not honor JSON mode', () => {
    it('accepts an answer wrapped in a code fence', async () => {
      h.ai.handlers.triage = () => '```json\n{"queryType":"DATA_QUESTION"}\n```';
      h.ai.handlers.schema = () => 'Here is the analysis:\n{"inScope": true, "relevantTables": [], "relationships": []}';
      h.ai.useSql('SELECT count(*)::int AS n FROM customers');

      const { status, body } = await h.ask('How many customers are there?');

      assert.equal(status, 200);
      assert.ok(body.response.includes('{"n":2}'), body.response);
    });
  });

  describe('when the provider fails', () => {
    for (const [status, label] of [[401, 'a refused key'], [402, 'no credit left'], [429, 'a rate limit'], [503, 'no provider available']] as const) {
      it(`answers 500 on ${label} (HTTP ${status}) without leaking the provider's message`, async () => {
        h.ai.handlers.triage = () => rawBody(status, { error: { message: 'secret provider detail', code: status } });

        const { status: httpStatus, body } = await h.ask('How many customers are there?');

        assert.equal(httpStatus, 500);
        assert.deepEqual(body, { error: 'Failed to process query' });
      });
    }

    it('answers 500 when OpenRouter replies 200 with an error and no answer', async () => {
      h.ai.handlers.triage = () => rawBody(200, { error: { message: 'Provider returned error', code: 502 } });

      const { status, body } = await h.ask('How many customers are there?');

      assert.equal(status, 500);
      assert.deepEqual(body, { error: 'Failed to process query' });
    });

    it('keeps the table of an upload when the description fails, so the upload can be retried', async () => {
      h.ai.handlers.tableSummary = () => rawBody(402, { error: { message: 'Insufficient credits', code: 402 } });
      const failed = await h.upload('later', 'a,b\n1,2\n');
      assert.equal(failed.status, 500);

      delete h.ai.handlers.tableSummary;
      const retried = await h.upload('later', 'a,b\n1,2\n');
      assert.equal(retried.status, 200);
    });
  });
});
