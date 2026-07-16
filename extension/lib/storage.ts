import { storage } from 'wxt/utils/storage';
import { DEFAULT_API_BASE_URL } from '@/lib/config';

// Persisted in chrome.storage.local. The token is a Sanctum personal access
// token issued by the platform's "Connect extension" page.
export const tokenItem = storage.defineItem<string>('local:xgrow_token', {
  fallback: '',
});

export const apiBaseUrlItem = storage.defineItem<string>('local:xgrow_api_base', {
  fallback: DEFAULT_API_BASE_URL,
});

export async function getAuth(): Promise<{ token: string; apiBaseUrl: string }> {
  const [token, apiBaseUrl] = await Promise.all([
    tokenItem.getValue(),
    apiBaseUrlItem.getValue(),
  ]);

  return { token, apiBaseUrl };
}

export async function setAuth(token: string, apiBaseUrl: string): Promise<void> {
  await Promise.all([
    tokenItem.setValue(token.trim()),
    apiBaseUrlItem.setValue(normalizeBaseUrl(apiBaseUrl)),
  ]);
}

export async function clearToken(): Promise<void> {
  await tokenItem.setValue('');
}

// Trim, drop a trailing slash, and ensure the URL ends with /api.
export function normalizeBaseUrl(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (!/\/api$/.test(base)) {
    base += '/api';
  }
  return base;
}
