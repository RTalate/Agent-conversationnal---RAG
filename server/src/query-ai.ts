import OpenAI from "openai";
import { config } from "./config";

// The OpenAI SDK speaks the protocol of any OpenAI-compatible API. By default the calls go to
// OpenRouter, which lets LLM_MODEL be any model it serves (for example "anthropic/claude-sonnet-4.5").
// Created on first use: importing this module needs no API key (the key is checked at startup).
let client: OpenAI | undefined;
function getClient(): OpenAI {
  client ??= new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseURL,
    defaultHeaders: { "X-Title": "AI SQL Query Generator" }, // shown in the OpenRouter activity log
  });
  return client;
}

// Every call classifies, writes SQL or summarizes data: deterministic output is what we want.
export async function queryAI(systemPrompt: string, userPrompt: string, jsonMode: boolean = false): Promise<string> {
  const completion = await getClient().chat.completions.create({
    model: config.llm.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    response_format: jsonMode && config.llm.jsonMode ? { type: "json_object" } : undefined,
  });

  const message = completion.choices?.[0]?.message;
  if (!message) {
    // OpenRouter can answer 200 with an error object when the provider failed.
    const reason = (completion as { error?: { message?: string } }).error?.message;
    throw new Error(`The model returned no answer${reason ? `: ${reason}` : ""}`);
  }
  return message.content || "";
}

// Models do not all honor JSON mode: some wrap the object in a ```json fence or add a sentence
// around it. Try the answer as is, then without the fence, then from the first "{" to the last "}".
function jsonCandidates(raw: string): string[] {
  const text = raw.trim();
  const candidates = [text];
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  return candidates;
}

// Parses a JSON-mode response, failing with a readable error naming the pipeline step.
export function parseAIJson<T>(raw: string, step: string): T {
  let parsed: unknown;
  let valid = false;
  for (const candidate of jsonCandidates(raw)) {
    try {
      parsed = JSON.parse(candidate);
      valid = true;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!valid) {
    throw new Error(`The AI returned invalid JSON during ${step}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`The AI returned an unexpected response during ${step}`);
  }
  return parsed as T;
}
