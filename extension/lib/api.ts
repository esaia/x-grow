import type {
  GenerateResponse,
  MeResponse,
  PostPayload,
  RecentPayload,
  RecentResponse,
  ReplyPayload,
} from '@/lib/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(
  base: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(base + path, { ...init, headers });
  } catch {
    throw new ApiError(0, `Could not reach the API at ${base}. Is the server running?`);
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }

  if (!res.ok) {
    const message =
      (data as { message?: string })?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return data as T;
}

export function getMe(base: string, token: string): Promise<MeResponse> {
  return apiFetch<MeResponse>(base, token, '/me');
}

export function generateReply(
  base: string,
  token: string,
  payload: ReplyPayload,
): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>(base, token, '/generate/reply', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function generatePost(
  base: string,
  token: string,
  payload: PostPayload,
): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>(base, token, '/generate/post', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function recentGeneration(
  base: string,
  token: string,
  payload: RecentPayload,
): Promise<RecentResponse> {
  return apiFetch<RecentResponse>(base, token, '/generate/recent', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function learnVoice(
  base: string,
  token: string,
  handle: string | null,
  posts: string[],
): Promise<{ voice_analysis: string; x_handle: string | null; count: number }> {
  return apiFetch(base, token, '/voice/learn', {
    method: 'POST',
    body: JSON.stringify({ handle, posts }),
  });
}
