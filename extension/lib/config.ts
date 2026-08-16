/** Default OpenAI endpoint. Overridable for proxies / compatible providers. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

/**
 * Default model.
 *
 * Was `gpt-4o` (what the platform shipped) until the reply panel's spinner got
 * long enough to be the thing users noticed about it. Generation happens
 * mid-scroll, so latency is a feature here and `gpt-4.1-mini` is roughly twice
 * as fast. It is only the default — Settings overrides it, so anyone who wants
 * the older model's output back can type it in.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

/**
 * How many reply options the composer panel asks for.
 *
 * Back to 3 from 5: five options is more than anyone reads before picking one,
 * and each extra option is output tokens on the critical path.
 */
export const REPLY_OPTION_COUNT = 3;

/** Hard character limit for a single X post. */
export const MAX_TWEET = 280;
