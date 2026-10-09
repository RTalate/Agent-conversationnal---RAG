import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAIJson } from '../../src/query-ai';

describe('parseAIJson', () => {
  it('parses a JSON object', () => {
    assert.deepEqual(parseAIJson('{"queryType":"DATA_QUESTION"}', 'triage'), { queryType: 'DATA_QUESTION' });
  });

  // Not every model honors JSON mode: some wrap the object in a code fence or add a sentence around it.
  const tolerated: Array<[label: string, raw: string]> = [
    ['a ```json fence', '```json\n{"queryType":"DATA_QUESTION"}\n```'],
    ['a plain ``` fence', '```\n{"queryType":"DATA_QUESTION"}\n```'],
    ['a fence and surrounding blanks', '  \n```json\n{"queryType":"DATA_QUESTION"}\n```\n  '],
    ['a sentence before', 'Here is the classification: {"queryType":"DATA_QUESTION"}'],
    ['a sentence after', '{"queryType":"DATA_QUESTION"}\nLet me know if you need more.'],
    ['reasoning text around it', '<think>The user asks about data.</think>\n{"queryType":"DATA_QUESTION"}'],
  ];
  for (const [label, raw] of tolerated) {
    it(`accepts the object even with ${label}`, () => {
      assert.deepEqual(parseAIJson(raw, 'triage'), { queryType: 'DATA_QUESTION' });
    });
  }

  it('keeps nested objects and braces inside strings', () => {
    const raw = '```json\n{"query":"SELECT \'{x}\' AS braces","explanation":{"why":"test"}}\n```';
    assert.deepEqual(parseAIJson(raw, 'SQL generation'), { query: "SELECT '{x}' AS braces", explanation: { why: 'test' } });
  });

  for (const raw of ['not json', '', '{"unterminated": ', "{'single': 'quotes'}", '```json\nnot json\n```', 'no braces at all']) {
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
