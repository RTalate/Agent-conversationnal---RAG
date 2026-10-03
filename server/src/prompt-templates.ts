export interface SchemaContext {
  tables: Array<{
    tableName: string;
    analysis: any;
  }>;
}

// Add response type definitions
export interface TriageResponse {
  queryType: 'GENERAL_QUESTION' | 'DATA_QUESTION' | 'OUT_OF_SCOPE';
}

export interface SchemaAnalysisResponse {
  inScope: boolean;
  outOfScopeReason?: string;
  relevantTables: Array<{
    tableName: string;
    fields: string[];
    reason: string;
  }>;
  relationships: string[];
}

export interface ValidateAnswerResponse {
  isAnswered: boolean;
  reason?: string;
}

export const prompts = {
  triage: (userQuery: string) => ({
    system: `You are a query classifier that categorizes questions into three types.
Users are expected to ask questions about various tables in our database.
However, they may also ask general questions that relate to data analysis.
We want to classify questions unrelated to data analysis as "OUT_OF_SCOPE".
Respond in JSON format matching this schema:
{
  "queryType": "GENERAL_QUESTION" | "DATA_QUESTION" | "OUT_OF_SCOPE"
}`,
    user: `Classify this question: ${userQuery}`
  }),

  generalAnswer: (userQuery: string) => ({
    system: `You are a helpful data analysis expert.
Provide clear, accurate answers about data and SQL/querying concepts.
Use examples when helpful and maintain a professional tone.
Respond in JSON format matching this schema:
{
  "answer": "string"
}`,
    user: `Please answer this question: ${userQuery}`,
  }),

  schemaAnalysis: ({ tables }: SchemaContext, userQuery: string) => ({
    system: `You are a database schema analyst.
Analyze which tables and fields would be needed to answer the user's question.
If the question cannot be answered with the available tables, respond with inScope set to false.
If inScope is false, provide a reason in the outOfScopeReason field.
If the answer can be answered with the available tables, respond with inScope set to true and
list the relevant tables and fields in the relevantTables array.
List any join keys and relationships in the relationships array with strings like "table1.id = table2.id".
Respond in JSON format matching this schema:
{
  "inScope": boolean,
  "outOfScopeReason": string,
  "relevantTables": [
    {
      "tableName": "string",
      "fields": string[],
      "reason": "string"
    }
  ],
  "relationships": string[],
}`,
    user: `Available Schema:
${tables.map(t => `Table: ${t.tableName}\nSchema: ${JSON.stringify(t.analysis)}`).join('\n\n')}

Question: ${userQuery}`,
  }),

  generateSQL: (schemaContext: SchemaAnalysisResponse, userQuery: string) => ({
    system: `You are a PostgreSQL query generator. Follow these rules:
1. Generate precise, efficient PostgreSQL-compliant queries based on schema analysis.
2. When necessary, use the relationships array to join tables.
3. Use "ILIKE" for case-insensitive pattern matching. For exact matches, use "="
4. For partial string matches, use ILIKE with % wildcards (e.g., column ILIKE '%pattern%')
5. Use a maximum limit of 1000 whenever a limit is not specified.
6. Always use the column names provided in the schema and never reference columns outside of that.
7. Use PostgreSQL-specific features when appropriate:
   - Use DISTINCT ON instead of GROUP BY when selecting unique rows
   - Use STRING_AGG for string concatenation
   - Use DATE_TRUNC for date/time operations
   - Use WITH for Common Table Expressions (CTEs)
8. Make sure that the query fully answers the user's question.
Respond in JSON format matching this schema:
{
  "query": "string",
  "explanation": "string"
}`,
    user: `Using this schema analysis, generate a SQL query:
${JSON.stringify(schemaContext, null, 2)}
---
Question that needs to be answered: ${userQuery}`,
  }),

  formatAnswer: (question: string, sqlQuery: string, queryResults: any[]) => ({
    system: `You are a database assistant, an expert that explains query results in clear, natural language.
Provide a concise answer that directly addresses the user's question based on the query results.
Respond in JSON format matching this schema:
{
  "answer": "string"
}`,
    user: `Question: ${question}
---
SQL Query Used: ${sqlQuery}
---
Query Results: ${JSON.stringify(queryResults)}`,
  }),

  validateAnswer: (question: string, answer: string) => ({
    system: `You are the final step of a data analysis pipeline - a final quality check if you will.
Determine if the provided answer is reasonable for the given question.
Most of the time, the answer will be adequate - even if the contents are fictional or made up.
Do not reject answers that are not perfect, as long as they are reasonable.
Respond in JSON format matching this schema:
{
  "isAnswered": boolean,
  "reason": string // Required if isAnswered is false, explaining why the answer is insufficient
}`,
    user: `Question: ${question}
Answer: ${answer}`,
  }),

  regenerateSQL: (schemaContext: SchemaAnalysisResponse, userQuery: string, previousQuery: string, error: string) => ({
    system: `You are a PostgreSQL query generator. Follow these rules:
1. Generate precise, efficient PostgreSQL-compliant queries based on schema analysis.
2. When necessary, use the relationships array to join tables.
3. Use "ILIKE" for case-insensitive pattern matching. For exact matches, use "="
4. For partial string matches, use ILIKE with % wildcards (e.g., column ILIKE '%pattern%')
5. Use a maximum limit of 1000 whenever a limit is not specified.
6. Always use the column names provided in the schema and never reference columns outside of that.
7. Use PostgreSQL-specific features when appropriate:
   - Use DISTINCT ON instead of GROUP BY when selecting unique rows
   - Use STRING_AGG for string concatenation
   - Use DATE_TRUNC for date/time operations
   - Use WITH for Common Table Expressions (CTEs)
8. Make sure that the query fully answers the user's question.
9. Consider the previous query that failed and its error message to avoid similar issues.
Respond in JSON format matching this schema:
{
  "query": "string",
  "explanation": "string"
}`,
    user: `Using this schema analysis, generate a SQL query:
${JSON.stringify(schemaContext, null, 2)}
---
Question that needs to be answered: ${userQuery}
---
Previous failed query: ${previousQuery}
Error encountered: ${error}`,
  })
}; 