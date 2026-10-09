import "dotenv/config";
import path from "node:path";

// Every setting of the server is read here, once, so that the defaults live in one place.
// Environment variables are described in the README ("Configuration").

export class ConfigError extends Error {}

export interface Config {
  server: { port: number };
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    /** Role with SELECT-only privileges used for the SQL written by the AI (optional). */
    readOnlyUser?: string;
    readOnlyPassword?: string;
  };
  embedded: {
    /** true: the server starts and stops its own PostgreSQL. false: it connects to an existing one. */
    enabled: boolean;
    dataDir: string;
  };
  llm: {
    apiKey: string;
    /** Any OpenAI-compatible API: OpenRouter by default. */
    baseURL: string;
    model: string;
    /** Ask the model for a JSON object (response_format). Some models or providers reject it. */
    jsonMode: boolean;
    /** Set when OPENAI_API_KEY is present, to explain that it is no longer read. */
    legacyKeyPresent: boolean;
  };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const text = (name: string, fallback: string) => env[name]?.trim() || fallback;

  const flag = (name: string, fallback: boolean) => {
    const value = env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    return !["0", "false", "no", "off"].includes(value);
  };

  const port = (name: string, fallback: number) => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      throw new ConfigError(`${name} must be a port number between 1 and 65535 (got "${value}").`);
    }
    return number;
  };

  const baseURL = text("LLM_BASE_URL", "https://openrouter.ai/api/v1");
  try {
    new URL(baseURL);
  } catch {
    throw new ConfigError(`LLM_BASE_URL must be a URL (got "${baseURL}").`);
  }

  return {
    server: { port: port("PORT", 3000) },
    db: {
      host: text("DB_HOST", "127.0.0.1"),
      port: port("DB_PORT", 54329),
      name: text("DB_NAME", "sqlgen"),
      user: text("DB_USER", "postgres"),
      password: text("DB_PASSWORD", "admin"),
      readOnlyUser: env.DB_READONLY_USER?.trim() || undefined,
      readOnlyPassword: env.DB_READONLY_PASSWORD,
    },
    embedded: {
      enabled: flag("DB_EMBEDDED", true),
      dataDir: path.resolve(text("DB_DATA_DIR", path.join(__dirname, "..", ".data", "postgres"))),
    },
    llm: {
      apiKey: env.OPENROUTER_API_KEY?.trim() ?? "",
      baseURL,
      model: text("LLM_MODEL", "openai/gpt-4o-mini"),
      jsonMode: flag("LLM_JSON_MODE", true),
      legacyKeyPresent: Boolean(env.OPENAI_API_KEY?.trim()),
    },
  };
}

export const config = loadConfig(process.env);

/** Fails with an actionable message when the AI cannot be called. Checked once, at startup. */
export function assertLlmConfigured(llm: Config["llm"] = config.llm): void {
  if (llm.apiKey) return;
  throw new ConfigError(
    "OPENROUTER_API_KEY is not set. Create a key at https://openrouter.ai/keys and put it in server/.env." +
      (llm.legacyKeyPresent ? " OPENAI_API_KEY is no longer read." : "")
  );
}
