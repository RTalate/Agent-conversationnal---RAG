import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAIJson } from '../../src/query-ai';

describe('parseAIJson', () => {
  it('parses a JSON object', () => {
    assert.deepEqual(parseAIJson('{"queryType":"DATA_QUESTION"}', 'triage'), { queryType: 'DATA_QUESTION' });
  });

  for (const raw of ['not json', '', '{"unterminated": ', "{'single': 'quotes'}"]) {
    it(`reports invalid JSON and names the step: ${JSON.stringify(raw)}`, () => {
      assert.throws(() => parseAIJson(raw, 'schema analysis'), /invalid JSON during schema analysis/);
    });
  }

  // Valid JSON that is not an object would make `.queryType`, `.query`... fail with an obscure TypeError.
  for (const raw of ['null', '42', '"text"', 'true']) {
    it(`rejects valid JSON that is not an object: ${raw}`, () => {
      assert.throws(() => parseAIJson(raw, 'SQL generation'), /unexpected response during SQL generation/);
    });
  }
});
