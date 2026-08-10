import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      /*
       * Vite 8's default (Oxc) minifier merges modules into one scope and has
       * been observed reusing a single short name for two different top-level
       * bindings — it gave React DOM's lane constant and our KEY_FIELDS array
       * the same `var Ke`. React then does `Ke <<= 1` on its lane, turning our
       * array into a number, and the dashboard died with
       * "Cannot read properties of undefined (reading 'filter')".
       *
       * esbuild renames correctly. Verify with the duplicate-binding check in
       * `npm run check:bundle` before changing this.
       */
      minify: 'esbuild' as const,
    },
  }),
  manifest: {
    name: 'X-Grow — AI for X',
    description:
      'Generate replies and posts in your own voice, right inside X (Twitter).',
    // `unlimitedStorage` lifts the 10MB cap on IndexedDB — the inspiration
    // board keeps up to 150 posts per tracked creator.
    // `alarms` drives the per-minute publish tick; `notifications` is the only
    // way a failed post can reach the user, since there is no server to email.
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'notifications'],
    host_permissions: [
      // Pages the extension reads tweets from and injects its UI into.
      'https://x.com/*',
      'https://twitter.com/*',
      // The only outbound call the extension makes. A custom base URL (a proxy
      // or an OpenAI-compatible provider) needs its host added here too.
      'https://api.openai.com/*',
    ],
    action: {
      default_title: 'X-Grow',
    },
  },
});
