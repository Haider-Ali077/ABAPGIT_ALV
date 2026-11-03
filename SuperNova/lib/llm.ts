// Provider-agnostic LLM wrapper. Speaks the OpenAI-compatible chat completions
// format only, configured through LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
// No vendor SDK. Every response is saved to data/llm-cache so runs can be
// replayed offline (LLM_MODE=replay).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type LlmRequest = {
  system: string;
  messages: ChatMessage[];
  jsonSchema?: object;
  /** Label for the cache file, e.g. "interviewer". Not part of the cache key. */
  tag?: string;
};

export type LlmResult<T = unknown> = {
  text: string;
  json: T | undefined;
  replayed: boolean;
  attempts: number;
  model: string;
};

type Mode = "record" | "replay" | "auto";

const CACHE_DIR = path.join(process.cwd(), "data", "llm-cache");
const MAX_JSON_RETRIES = 2;
const ajv = new Ajv({ allErrors: true, strict: false });

// Some models reject temperature or response_format; remember that per process.
const unsupported = { temperature: false, responseFormat: false };

export function llmConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").trim();
  const mode = (process.env.LLM_MODE || "record").trim().toLowerCase() as Mode;
  return {
    baseUrl,
    model: (process.env.LLM_MODEL || "gpt-4.1").trim(),
    apiKey: (process.env.LLM_API_KEY || "").trim(),
    mode: (["record", "replay", "auto"].includes(mode) ? mode : "record") as Mode,
  };
}

/** Safe to show in the UI: no key, only whether one is set. */
export function llmPublicInfo() {
  const c = llmConfig();
  let host = c.baseUrl;
  try {
    host = new URL(c.baseUrl).host;
  } catch {}
  return { mode: c.mode, model: c.model, host, keySet: c.apiKey.length > 0 };
}

export class LlmError extends Error {}

export async function callLLM<T = unknown>(req: LlmRequest): Promise<LlmResult<T>> {
  const cfg = llmConfig();
  const system = req.jsonSchema
    ? `${req.system}\n\n## JSON schema of your answer\n${JSON.stringify(req.jsonSchema)}`
    : req.system;
  const key = cacheKey(system, req.messages, req.jsonSchema);

  if (cfg.mode !== "record") {
    const cached = readCache(key);
    if (cached !== undefined) {
      return { text: cached, json: req.jsonSchema ? (parseJson(cached) as T) : undefined, replayed: true, attempts: 0, model: "replay" };
    }
    if (cfg.mode === "replay") {
      throw new LlmError(
        "Replay mode: no recorded response for this exact input. Run once with LLM_MODE=record (same inputs) to record it.",
      );
    }
  }

  const messages: ChatMessage[] = [...req.messages];
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_JSON_RETRIES + 1; attempt++) {
    const text = cleanText(await chatCompletion(cfg, system, messages, !!req.jsonSchema));
    if (!req.jsonSchema) {
      writeCache(key, req.tag, cfg.model, text);
      return { text, json: undefined, replayed: false, attempts: attempt, model: cfg.model };
    }
    const problem = validateJson(text, req.jsonSchema);
    if (!problem) {
      writeCache(key, req.tag, cfg.model, text);
      return { text, json: parseJson(text) as T, replayed: false, attempts: attempt, model: cfg.model };
    }
    lastError = problem;
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content: `Your previous reply was not valid: ${problem}\nReply again with only one JSON object that matches the schema. No prose, no code fence.`,
      },
    );
  }
  throw new LlmError(`LLM did not return valid JSON after ${MAX_JSON_RETRIES + 1} attempts: ${lastError}`);
}

async function chatCompletion(
  cfg: ReturnType<typeof llmConfig>,
  system: string,
  messages: ChatMessage[],
  wantJson: boolean,
): Promise<string> {
  if (!cfg.apiKey && !isLocal(cfg.baseUrl)) {
    throw new LlmError("LLM_API_KEY is not set. Add it to .env and restart `npm run dev`.");
  }
  const url = completionsUrl(cfg.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (/azure/i.test(url.host)) headers["api-key"] = cfg.apiKey;
  }

  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [{ role: "system", content: system }, ...messages],
    };
    if (!unsupported.temperature) body.temperature = 0.1;
    if (wantJson && !unsupported.responseFormat) body.response_format = { type: "json_object" };

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
    } catch (e) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new LlmError(redact(`LLM request failed: ${(e as Error).message}`, cfg.apiKey));
    }

    if (res.ok) {
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new LlmError("LLM response has no message content.");
      return content;
    }

    const errText = await res.text();
    if (res.status === 400 && /temperature/i.test(errText) && !unsupported.temperature) {
      unsupported.temperature = true;
      continue;
    }
    if (res.status === 400 && /response_format|json_object/i.test(errText) && !unsupported.responseFormat) {
      unsupported.responseFormat = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    throw new LlmError(redact(`LLM HTTP ${res.status}: ${errText.slice(0, 500)}`, cfg.apiKey));
  }
}

/** Appends /chat/completions to the path, keeping a query string (Azure api-version). */
function completionsUrl(baseUrl: string): URL {
  const u = new URL(baseUrl);
  u.pathname = u.pathname.replace(/\/+$/, "") + "/chat/completions";
  return u;
}

function isLocal(baseUrl: string) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Strips code fences and <think> blocks some models add around the answer. */
function cleanText(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1].trim();
  return t;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function validateJson(text: string, schema: object): string | undefined {
  let data: unknown;
  try {
    data = parseJson(text);
  } catch (e) {
    return `JSON parse error: ${(e as Error).message}`;
  }
  const validate = ajv.compile(schema);
  if (validate(data)) return undefined;
  return (validate.errors || [])
    .slice(0, 8)
    .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
    .join("; ");
}

function cacheKey(system: string, messages: ChatMessage[], schema?: object) {
  return createHash("sha256").update(JSON.stringify({ system, messages, schema: schema ?? null })).digest("hex");
}

function readCache(key: string): string | undefined {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { text: string }).text;
}

function writeCache(key: string, tag: string | undefined, model: string, text: string) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const record = { tag: tag ?? null, model, recorded_at: new Date().toISOString(), text };
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(record, null, 2));
}

function redact(message: string, apiKey: string) {
  return apiKey ? message.split(apiKey).join("***") : message;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
