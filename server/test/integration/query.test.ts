import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness';

const QUESTION = 'How many customers are there per country?';
const COUNT_CUSTOMERS = 'SELECT count(*)::int AS n FROM customers';

describe('POST /query', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(() => h.stop());

  beforeEach(async () => {
    await h.reset();
    await h.sql('CREATE TABLE customers (id int, country text)');
    await h.sql("INSERT INTO customers VALUES (1, 'France'), (2, 'France'), (3, 'Spain')");
    await h.sql(
      "INSERT INTO table_schema (table_name, analysis) VALUES ('customers', $1)",
      [{ id: 'Customer number', country: 'Country of the customer' }]
    );
  });

  const steps = () => h.ai.calls.map(call => call.step);
  const tables = async () => (await h.sql("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map(r => r.tablename);
  async function assertDataIntact() {
    assert.deepEqual(await h.sql('SELECT id FROM customers ORDER BY id'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.deepEqual(await tables(), ['customers', 'table_schema']);
  }

  describe('a question about the data', () => {
    it('goes through every step of the pipeline and answers with the query results', async () => {
      h.ai.useSql('SELECT country, count(*)::int AS n FROM customers GROUP BY country ORDER BY country');

      const { status, body } = await h.ask(QUESTION);

      assert.equal(status, 200);
      assert.equal(body.queryType, 'DATA_QUESTION');
      assert.ok(body.response.includes('[{"country":"France","n":2},{"country":"Spain","n":1}]'), body.response);
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
      assert.deepEqual(steps(), ['triage', 'schema', 'sql', 'format', 'validate']);
    });

    it('sends the question once in the triage prompt', async () => {
      const question = 'Which ZEBRA-QUESTION is this?';
      await h.ask(question);

      const [triage] = h.ai.callsTo('triage');
      assert.equal(triage.user.split(question).length - 1, 1);
    });

    it('uses a temperature of 0 and the default model for every call', async () => {
      await h.ask(QUESTION);

      assert.ok(h.ai.calls.length >= 5);
      for (const call of h.ai.calls) {
        assert.equal(call.temperature, 0, `${call.step} used temperature ${call.temperature}`);
        assert.equal(call.model, 'openai/gpt-4o-mini', call.step);
      }
    });

    it('only offers the AI the tables that have been analyzed', async () => {
      await h.sql('CREATE TABLE pending (x int)');
      await h.sql("INSERT INTO table_schema (table_name, analysis) VALUES ('pending', NULL)");

      await h.ask(QUESTION);

      const [schema] = h.ai.callsTo('schema');
      assert.match(schema.user, /Table: customers/);
      assert.doesNotMatch(schema.user, /pending/);
    });
  });

  describe('SQL written by the AI that tries to change the database', () => {
    const attacks: Array<[label: string, sql: string]> = [
      ['DROP TABLE', 'DROP TABLE customers'],
      ['DELETE', 'DELETE FROM customers'],
      ['UPDATE', "UPDATE customers SET country = 'nowhere'"],
      ['stacked statements', 'SELECT 1; DROP TABLE customers'],
      ['stacked statements that end the transaction first', 'SELECT 1; COMMIT; DROP TABLE customers'],
      ['DELETE inside a CTE', 'WITH d AS (DELETE FROM customers RETURNING *) SELECT count(*) FROM d'],
      ['SELECT INTO', 'SELECT * INTO stolen FROM customers'],
    ];

    for (const [label, sql] of attacks) {
      it(`${label}: refused, the AI is told why and writes a valid query instead`, async () => {
        h.ai.useSql(sql, COUNT_CUSTOMERS);

        const { status, body } = await h.ask(QUESTION);

        assert.equal(status, 200);
        assert.ok(body.response.includes('{"n":3}'), body.response);
        const [retry] = h.ai.callsTo('sqlRetry');
        assert.ok(retry.user.includes(`Previous failed query: ${sql}`));
        assert.match(retry.user, /Error encountered: \S/);
        await assertDataIntact();
      });
    }

    it('gives up after three attempts if the AI keeps writing it', async () => {
      h.ai.useSql('DROP TABLE customers');

      const { status, body } = await h.ask(QUESTION);

      assert.equal(status, 200);
      assert.match(body.response, /unable to generate a satisfactory answer/);
      assert.deepEqual(steps().filter(step => step === 'sql' || step === 'sqlRetry'), ['sql', 'sqlRetry', 'sqlRetry']);
      assert.ok(!steps().includes('format'), 'nothing was executed, so there is nothing to format');
      await assertDataIntact();
    });
  });

  describe('unreliable answers from the AI', () => {
    it('retries when the SQL step does not return valid JSON', async () => {
      h.ai.handlers.sql = () => 'oops, no JSON here';
      h.ai.useSql(COUNT_CUSTOMERS);

      const { status, body } = await h.ask(QUESTION);

      assert.equal(status, 200);
      assert.ok(body.response.includes('{"n":3}'), body.response);
      assert.equal(h.ai.callsTo('sqlRetry').length, 1);
    });

    it('retries when the SQL step returns no query', async () => {
      h.ai.handlers.sql = () => ({ explanation: 'I forgot the query' });
      h.ai.useSql(COUNT_CUSTOMERS);

      const { status, body } = await h.ask(QUESTION);

      assert.equal(status, 200);
      assert.ok(body.response.includes('{"n":3}'), body.response);
    });

    it('retries, quoting the reason, when the answer does not address the question', async () => {
      let validations = 0;
      h.ai.handlers.validate = () => (validations++ === 0 ? { isAnswered: false, reason: 'It talks about something else' } : { isAnswered: true });
      h.ai.useSql(COUNT_CUSTOMERS);

      const { status, body } = await h.ask(QUESTION);

      assert.equal(status, 200);
      assert.ok(body.response.includes('{"n":3}'), body.response);
      assert.match(h.ai.callsTo('sqlRetry')[0].user, /It talks about something else/);
    });

    it('fails with a 500 when triage does not return valid JSON', async () => {
      h.ai.handlers.triage = () => 'not json';

      const { status, body } = await h.ask(QUESTION);

      assert.equal(status, 500);
      assert.deepEqual(body, { error: 'Failed to process query' });
      assert.deepEqual(steps(), ['triage']);
    });

    it('fails with a 500 when triage returns a type that does not exist', async () => {
      h.ai.handlers.triage = () => ({ queryType: 'SOMETHING_ELSE' });

      const { status } = await h.ask(QUESTION);

      assert.equal(status, 500);
    });
  });

  describe('other kinds of question', () => {
    it('answers a general question without touching the data', async () => {
      h.ai.handlers.triage = () => ({ queryType: 'GENERAL_QUESTION' });

      const { status, body } = await h.ask('What is a primary key?');

      assert.equal(status, 200);
      assert.equal(body.queryType, 'GENERAL_QUESTION');
      assert.equal(body.response, 'A general answer.');
      assert.deepEqual(steps(), ['triage', 'general']);
    });

    it('politely declines a question outside the scope', async () => {
      h.ai.handlers.triage = () => ({ queryType: 'OUT_OF_SCOPE' });

      const { status, body } = await h.ask('What is the weather like?');

      assert.equal(status, 200);
      assert.equal(body.queryType, 'OUT_OF_SCOPE');
      assert.match(body.response, /outside the scope/);
      assert.deepEqual(steps(), ['triage']);
    });

    it('explains when the available tables cannot answer the question', async () => {
      h.ai.handlers.schema = () => ({ inScope: false, outOfScopeReason: 'There is no weather table.', relevantTables: [], relationships: [] });

      const { status, body } = await h.ask('What is the weather like?');

      assert.equal(status, 200);
      assert.match(body.response, /There is no weather table\./);
      assert.deepEqual(steps(), ['triage', 'schema']);
    });
  });

  describe('input validation', () => {
    const invalid: Array<[label: string, message: unknown]> = [
      ['no message', undefined],
      ['an empty message', ''],
      ['a blank message', '   '],
      ['a number', 42],
      ['null', null],
      ['an array', ['How many customers?']],
      ['an object', { text: 'How many customers?' }],
    ];
    for (const [label, message] of invalid) {
      it(`rejects ${label} without calling the AI`, async () => {
        const { status, body } = await h.ask(message);

        assert.equal(status, 400);
        assert.match(body.error, /"message" is required/);
        assert.deepEqual(h.ai.calls, []);
      });
    }
  });
});
