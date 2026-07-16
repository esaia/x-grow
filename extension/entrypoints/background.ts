import { browser } from 'wxt/browser';
import {
  ApiError,
  generatePost,
  generateReply,
  getMe,
  learnVoice,
  recentGeneration,
} from '@/lib/api';
import type { BgRequest } from '@/lib/messaging';
import { clearToken, getAuth, setAuth } from '@/lib/storage';
import type { AuthState } from '@/lib/types';

async function currentAuthState(): Promise<AuthState> {
  const { token, apiBaseUrl } = await getAuth();
  if (!token) {
    return { connected: false, apiBaseUrl, me: null };
  }

  try {
    const me = await getMe(apiBaseUrl, token);
    return { connected: true, apiBaseUrl, me };
  } catch {
    // Token invalid/expired or server unreachable — treat as disconnected.
    return { connected: false, apiBaseUrl, me: null };
  }
}

async function handle(message: BgRequest): Promise<unknown> {
  switch (message.type) {
    case 'auth:get':
      return currentAuthState();

    case 'auth:save': {
      // Verify the token works before persisting it.
      const me = await getMe(message.apiBaseUrl, message.token);
      await setAuth(message.token, message.apiBaseUrl);
      const { apiBaseUrl } = await getAuth();
      return { connected: true, apiBaseUrl, me } satisfies AuthState;
    }

    case 'auth:logout':
      await clearToken();
      return currentAuthState();

    case 'generate:reply': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return generateReply(apiBaseUrl, token, message.payload);
    }

    case 'generate:post': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return generatePost(apiBaseUrl, token, message.payload);
    }

    case 'generate:recent': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return recentGeneration(apiBaseUrl, token, message.payload);
    }

    case 'voice:learn': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return learnVoice(apiBaseUrl, token, message.handle, message.posts);
    }
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message as BgRequest)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message ?? 'Unknown error',
          status: error?.status,
        }),
      );

    // Return true to keep the message channel open for the async response.
    return true;
  });
});
