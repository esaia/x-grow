/**
 * Thin wrapper around the OpenAI Chat Completions API.
 *
 * Ported from the platform's ClaudeService (misleading name, it always spoke
 * OpenAI). The key now lives in chrome.storage.local instead of a server .env,
 * so the one hard rule is: **only the background worker may call this**.
 * x.com's CSP blocks a content-script fetch to api.openai.com, and the key must
 * never be readable from a page context.
 */

/** Thrown for anything the UI should show the user verbatim. */
export class OpenAiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for a network failure. */
    readonly status: number = 0,
    /** True when the user simply hasn't added a key yet. */
    readonly missingKey: boolean = false,
  ) {
    super(message);
    this.name = 'OpenAiError';
  }
}

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface MessageResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export interface OptionsResult extends Omit<MessageResult, 'text'> {
  options: string[];
}

/** Matches the platform's Http::timeout(170). */
const TIMEOUT_MS = 170_000;

/**
 * Send a single-turn message.
 *
 * @param params Extra Chat Completions params (e.g. temperature,
 *               presence_penalty). Left empty by default so reasoning models
 *               that reject them still work.
 */
export async function message(
  config: OpenAiConfig,
  system: string,
  prompt: string,
  maxTokens = 1024,
  params: Record<string, unknown> = {},
): Promise<MessageResult> {
  if (config.apiKey.trim() === '') {
    throw new OpenAiError(
      'No OpenAI API key set. Add one in X-Grow settings.',
      0,
      true,
    );
  }

  const base = config.baseUrl.replace(/\/+$/, '');

  let response: Response;

  try {
    response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        ...params,
        model: config.model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new OpenAiError(`Could not reach OpenAI: ${reason}`, 0);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    throw new OpenAiError(
      `OpenAI API error (${response.status}): ${extractApiMessage(body)}`,
      response.status,
    );
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };

  return {
    text: (data.choices?.[0]?.message?.content ?? '').trim(),
    input_tokens: data.usage?.prompt_tokens ?? 0,
    output_tokens: data.usage?.completion_tokens ?? 0,
    model: data.model ?? config.model,
  };
}

/**
 * Ask the model for a set of distinct options, returned as an array of strings.
 */
export async function generateOptions(
  config: OpenAiConfig,
  system: string,
  prompt: string,
  count = 3,
  maxTokens = 1024,
  params: Record<string, unknown> = {},
): Promise<OptionsResult> {
  const instruction =
    prompt +
    '\n\n' +
    `Return ONLY a JSON object of the exact form {"options": ["..."]} containing exactly ${count} ` +
    'distinct options as strings. Do not include any commentary, keys, or text outside the JSON.';

  const result = await message(config, system, instruction, maxTokens, params);

  return {
    options: parseOptions(result.text, count).map(stripDashes),
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    model: result.model,
  };
}

/**
 * Best-effort extraction of the options array from the model's text.
 */
function parseOptions(text: string, count: number): string[] {
  // Strip markdown code fences the model sometimes adds.
  const clean = text.replace(/```(?:json)?/gi, '').trim();

  const match = clean.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      const decoded = JSON.parse(match[0]) as unknown;

      if (
        decoded &&
        typeof decoded === 'object' &&
        Array.isArray((decoded as { options?: unknown }).options)
      ) {
        const options = (decoded as { options: unknown[] }).options
          .map((option) => (typeof option === 'string' ? option.trim() : ''))
          .filter((option) => option !== '');

        if (options.length > 0) {
          return options.slice(0, count);
        }
      }
    } catch {
      // Fall through to the raw-text fallback below.
    }
  }

  // Fallback: hand back whatever text we got as a single option so the user
  // still gets something usable rather than an error.
  return clean === '' ? [] : [clean];
}

/**
 * Belt-and-suspenders: strip em/en-dashes even if the model ignores the prompt
 * instruction against using them.
 */
function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/gu, ', ').trim();
}

/** Pull OpenAI's `{error: {message}}` out of an error body when it's there. */
function extractApiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };

    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Not JSON — fall through.
  }

  return body.slice(0, 300);
}
