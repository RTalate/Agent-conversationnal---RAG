// Loaded with --require before every test file (see the "test" scripts in package.json).
// src/query-ai.ts builds the OpenAI client when it is imported, and the client refuses to be
// built without a key. Tests never reach OpenAI: integration tests point it to a local fake.
process.env.OPENAI_API_KEY ??= 'test-key';
