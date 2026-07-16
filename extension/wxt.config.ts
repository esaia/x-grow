import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'X-Grow — AI for X',
    description:
      'Generate replies and posts in your own voice, right inside X (Twitter).',
    permissions: ['storage'],
    // Pages the extension may read tweets from + the platform API it calls.
    // `http://localhost/*` matches any port (match patterns ignore the port),
    // which covers the local `php artisan serve` backend on :8000.
    // For production, add your deployed API domain, e.g. 'https://app.example.com/*'.
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    action: {
      default_title: 'X-Grow',
    },
  },
});
