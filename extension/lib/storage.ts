import { storage } from 'wxt/utils/storage';
import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from '@/lib/config';
import type { OpenAiConfig } from '@/lib/ai/openai';
import type { XAccount } from '@/lib/xdom';

/**
 * Settings live in chrome.storage.local; everything else (voice profile,
 * generations, schedule, inspiration) lives in IndexedDB — see lib/db.
 *
 * The API key is only ever read by the background worker. Content scripts get
 * a boolean ("is a key set?"), never the key itself.
 */

export const apiKeyItem = storage.defineItem<string>('local:xgrow_openai_key', {
  fallback: '',
});

export const modelItem = storage.defineItem<string>('local:xgrow_openai_model', {
  fallback: DEFAULT_OPENAI_MODEL,
});

export const baseUrlItem = storage.defineItem<string>('local:xgrow_openai_base', {
  fallback: DEFAULT_OPENAI_BASE_URL,
});

/**
 * The connected X account. Read off the page rather than obtained through
 * OAuth — see readLoggedInAccount() — but still stored explicitly, because
 * connecting is a decision the user makes once, not something we infer on every
 * page load. It also survives the user browsing while logged out.
 */
export const accountItem = storage.defineItem<XAccount | null>(
  'local:xgrow_account',
  { fallback: null },
);

export async function getOpenAiConfig(): Promise<OpenAiConfig> {
  const [apiKey, model, baseUrl] = await Promise.all([
    apiKeyItem.getValue(),
    modelItem.getValue(),
    baseUrlItem.getValue(),
  ]);

  return {
    apiKey,
    model: model.trim() || DEFAULT_OPENAI_MODEL,
    baseUrl: normalizeBaseUrl(baseUrl),
  };
}

export async function setOpenAiConfig(patch: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<void> {
  const writes: Promise<void>[] = [];

  if (patch.apiKey !== undefined) {
    writes.push(apiKeyItem.setValue(patch.apiKey.trim()));
  }

  if (patch.model !== undefined) {
    writes.push(modelItem.setValue(patch.model.trim() || DEFAULT_OPENAI_MODEL));
  }

  if (patch.baseUrl !== undefined) {
    writes.push(baseUrlItem.setValue(normalizeBaseUrl(patch.baseUrl)));
  }

  await Promise.all(writes);
}

/** Trim and drop any trailing slash; blank falls back to OpenAI's own host. */
export function normalizeBaseUrl(url: string): string {
  const base = url.trim().replace(/\/+$/, '');

  return base === '' ? DEFAULT_OPENAI_BASE_URL : base;
}
