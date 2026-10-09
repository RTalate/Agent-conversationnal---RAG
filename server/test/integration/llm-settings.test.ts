import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness';

// LLM_MODEL and LLM_JSON_MODE are read when the application starts, so they need a harness of their own.

describe('calls to the AI provider (changed settings)', () => {
  let h: Harness;

  before(async () => {
    h = await startHarness({ env: { LLM_MODEL: 'anthropic/claude-sonnet-4.5', LLM_JSON_MODE: 'false' } });
  });
  after(() => h.stop());

  it('uses the model from LLM_MODEL', async () => {
    await h.sql('CREATE TABLE customers (id int)');
    await h.sql("INSERT INTO table_schema (table_name, analysis) VALUES ('customers', $1)", [{ id: 'Id' }]);

    await h.ask('How many customers are there?');

    assert.ok(h.ai.calls.length >= 5);
    for (const call of h.ai.calls) assert.equal(call.model, 'anthropic/claude-sonnet-4.5', call.step);
  });

  it('does not send response_format when LLM_JSON_MODE is off', async () => {
    h.ai.reset();
    await h.ask('How many customers are there?');

    assert.ok(h.ai.calls.length >= 1);
    for (const call of h.ai.calls) assert.equal(call.responseFormat, undefined, call.step);
  });
});
