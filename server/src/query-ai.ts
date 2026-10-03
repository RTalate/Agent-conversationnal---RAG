import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Every call classifies, writes SQL or summarizes data: deterministic output is what we want.
export async function queryAI(systemPrompt: string, userPrompt: string, jsonMode: boolean = false): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    response_format: jsonMode ? { type: "json_object" } : undefined,
  });

  return completion.choices[0].message.content || "";
}

// Parses a JSON-mode response, failing with a readable error naming the pipeline step.
export function parseAIJson<T>(raw: string, step: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The AI returned invalid JSON during ${step}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`The AI returned an unexpected response during ${step}`);
  }
  return parsed as T;
}
