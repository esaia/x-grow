// Default API base URL used until the user overrides it in the popup.
// Points at the local `php artisan serve` backend. Include the /api prefix.
export const DEFAULT_API_BASE_URL = 'http://localhost:8001/api';

// How many options the ✨ panel asks for. The API validates this at max 5, so
// raising it further needs GenerateReplyRequest/GeneratePostRequest widened too.
export const REPLY_OPTION_COUNT = 5;

// Derive the dashboard (web) URL from an API base URL by stripping the /api suffix.
export function dashboardUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api\/?$/, '');
}
