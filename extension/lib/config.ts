/** Default OpenAI endpoint. Overridable for proxies / compatible providers. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

/** Default model. Matches what the platform shipped, so output doesn't shift. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/** How many reply options the composer panel asks for. */
export const REPLY_OPTION_COUNT = 5;

/** Hard character limit for a single X post. */
export const MAX_TWEET = 280;
