import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prompts, type SchemaAnalysisResponse } from '../../src/prompt-templates';

// A local stand-in for the OpenAI chat completions API, so that tests are fast, free and
// deterministic. It recognizes each step of the pipeline by comparing the system prompt with the
// ones in prompt-templates.ts, answers with sensible defaults, and lets a test script any step.

export type AiStep =
  | 'triage' | 'general' | 'schema' | 'sql' | 'sqlRetry' | 'format' | 'validate'
  | 'tableSummary'; // the per-column descriptions written when a CSV is uploaded

export interface AiCall {
  step: AiStep;
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  /** The response_format the application asked for, if any. */
  responseFormat?: unknown;
  /** Request path and headers, to check how the API is reached. */
  path?: string;
  headers?: http.IncomingHttpHeaders;
  /** For 'tableSummary': the data dictionary the application computed from the table. */
  dictionary?: Record<string, any>;
}

/** What a handler returns: an object is sent as JSON, a string is sent as is (e.g. invalid JSON). */
export type AiReply = Record<string, unknown> | string;

/** Replaces the whole HTTP answer, to simulate an API that fails in its own way. */
export const rawBody = (status: number, body: unknown): AiReply => ({ $raw: { status, body } });
type Handler = (call: AiCall) => AiReply;

const NO_SCHEMA: SchemaAnalysisResponse = { inScope: true, relevantTables: [], relationships: [] };
const SYSTEM_PROMPTS: Array<[AiStep, string]> = [
  ['triage', prompts.triage('').system],
  ['general', prompts.generalAnswer('').system],
  ['schema', prompts.schemaAnalysis({ tables: [] }, '').system],
  ['sql', prompts.generateSQL(NO_SCHEMA, '').system],
  ['sqlRetry', prompts.regenerateSQL(NO_SCHEMA, '', '', '').system],
  ['format', prompts.formatAnswer('', '', []).system],
  ['validate', prompts.validateAnswer('', '').system],
];

function identifyStep(system: string): AiStep | undefined {
  const known = SYSTEM_PROMPTS.find(([, prompt]) => prompt === system);
  if (known) return known[0];
  if (system.includes('data analyst tasked')) return 'tableSummary'; // prompt lives in tableAnalyzer.ts
  return undefined;
}

export class FakeOpenAI {
  /** Base URL to give to the OpenAI client (OPENAI_BASE_URL). */
  url = '';
  calls: AiCall[] = [];
  /** Per-test overrides of the default answers. */
  handlers: Partial<Record<AiStep, Handler>> = {};

  private server!: http.Server;
  private sqlQueue: string[] = [];

  static async start(): Promise<FakeOpenAI> {
    const ai = new FakeOpenAI();
    ai.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => ai.respond(JSON.parse(body || '{}'), req, res));
    });
    await new Promise<void>(resolve => ai.server.listen(0, '127.0.0.1', resolve));
    ai.url = `http://127.0.0.1:${(ai.server.address() as AddressInfo).port}/v1`;
    return ai;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** Forgets recorded calls and every override. */
  reset(): void {
    this.calls = [];
    this.handlers = {};
    this.sqlQueue = [];
  }

  /**
   * The SQL the model "writes": one query per generation attempt, in order. The last one is
   * repeated if the pipeline asks for more attempts than there are queries.
   */
  useSql(...queries: string[]): void {
    this.sqlQueue = [...queries];
  }

  /** Calls made to one step of the pipeline. */
  callsTo(step: AiStep): AiCall[] {
    return this.calls.filter(call => call.step === step);
  }

  private nextSql(): string {
    return (this.sqlQueue.length > 1 ? this.sqlQueue.shift() : this.sqlQueue[0]) ?? 'SELECT 1 AS n';
  }

  private defaultReply(call: AiCall): AiReply {
    switch (call.step) {
      case 'triage': return { queryType: 'DATA_QUESTION' };
      case 'general': return { answer: 'A general answer.' };
      case 'schema': return { inScope: true, relevantTables: [{ tableName: 'customers', fields: ['*'], reason: 'test' }], relationships: [] };
      case 'sql':
      case 'sqlRetry': return { query: this.nextSql(), explanation: 'test' };
      case 'format': return { answer: `ANSWER ${call.user.split('Query Results: ')[1] ?? ''}` };
      case 'validate': return { isAnswered: true };
      case 'tableSummary':
        return Object.fromEntries(Object.keys(call.dictionary ?? {}).map(column => [column, `The ${column} column.`]));
    }
  }

  private respond(request: any, req: http.IncomingMessage, res: http.ServerResponse): void {
    const [system, user] = [request.messages?.[0]?.content ?? '', request.messages?.[1]?.content ?? ''];
    const step = identifyStep(system);
    res.setHeader('content-type', 'application/json');
    if (!step) {
      // A prompt the fake does not know: fail loudly (a 4xx is not retried by the OpenAI client).
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: `FakeOpenAI: unrecognized prompt: ${system.slice(0, 80)}` } }));
      return;
    }

    const call: AiCall = {
      step, system, user, model: request.model, temperature: request.temperature,
      responseFormat: request.response_format, path: req.url, headers: req.headers,
    };
    if (step === 'tableSummary') {
      call.dictionary = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}\n\nFormat') + 1));
    }
    this.calls.push(call);

    const reply = (this.handlers[step] ?? ((c: AiCall) => this.defaultReply(c)))(call);
    if (typeof reply === 'object' && '$raw' in reply) {
      const { status, body } = reply.$raw as { status: number; body: unknown };
      res.statusCode = status;
      res.end(JSON.stringify(body));
      return;
    }
    res.end(JSON.stringify({
      id: 'fake', object: 'chat.completion', created: 0, model: request.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
    }));
  }
}
