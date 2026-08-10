/**
 * Mechanical style, measured from the owner's own posts.
 *
 * "Match the voice of the sample posts" is a weak instruction — models read it
 * as "be vaguely similar" and keep writing tidy, correctly-punctuated prose.
 * Measured facts are not weak: "78% of their posts start lowercase" and "they
 * almost never end with a period" are checkable constraints, and models follow
 * those far more reliably than adjectives.
 *
 * Every line is emitted only when the signal is strong enough to be real, so a
 * handful of posts never produces confident nonsense.
 */

/** Below this, the sample is too small for percentages to mean anything. */
const MIN_POSTS = 4;

/** How lopsided a habit must be before we state it as a rule. */
const STRONG = 0.7;
const RARE = 0.15;

const EMOJI = /\p{Extended_Pictographic}/u;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function share(posts: string[], test: (post: string) => boolean): number {
  return posts.filter(test).length / posts.length;
}

function collectPosts(sources: (string | null | undefined)[]): string[] {
  return sources
    .filter((source): source is string => typeof source === 'string')
    .flatMap((source) => source.split('\n'))
    .map((post) => post.trim())
    .filter((post) => post.length > 1);
}

/**
 * The owner's strong mechanical habits, for applying in code after generation.
 *
 * The prompt states these same rules, but a model still capitalizes and adds a
 * final full stop often enough that the output reads as edited prose next to
 * the owner's real posts. These are safe to enforce mechanically because they
 * are only ever emitted when the measured signal is lopsided.
 */
export interface StyleSignals {
  lowercaseStart: boolean;
  noTerminalStop: boolean;
  lowercaseI: boolean;
}

export function measureStyle(
  ...sources: (string | null | undefined)[]
): StyleSignals | null {
  const posts = collectPosts(sources);

  if (posts.length < MIN_POSTS) return null;

  return {
    lowercaseStart: share(posts, (post) => /^[a-z]/.test(post)) >= STRONG,
    noTerminalStop: share(posts, (post) => /[a-z0-9)"']$/i.test(post)) >= STRONG,
    lowercaseI: share(posts, (post) => /\bi\b/.test(post)) >= 0.25,
  };
}

/**
 * Rewrite one generated post/reply into the owner's measured mechanics.
 * Only ever loosens formality — it never adds punctuation or capitals.
 */
export function applyStyle(text: string, signals: StyleSignals): string {
  let out = text.trim();

  if (signals.lowercaseStart && /^[A-Z][^A-Z]/.test(out)) {
    // Second char check protects acronyms: "AI is..." must not become "aI is...".
    out = out[0].toLowerCase() + out.slice(1);
  }

  if (signals.lowercaseI) {
    out = out.replace(/\bI\b/g, 'i');
  }

  if (signals.noTerminalStop && /[^.]\.$/.test(out)) {
    // A single trailing full stop only — never an ellipsis.
    out = out.slice(0, -1);
  }

  return out;
}

/**
 * Turn the owner's raw posts into prompt lines describing how they actually
 * type. Returns an empty string when there isn't enough to go on.
 */
export function styleRules(...sources: (string | null | undefined)[]): string {
  const posts = collectPosts(sources);

  if (posts.length < MIN_POSTS) return '';

  const rules: string[] = [];

  // Capitalization.
  const lowerStart = share(posts, (post) => /^[a-z]/.test(post));

  if (lowerStart >= STRONG) {
    rules.push(
      `- ${Math.round(lowerStart * 100)}% of their posts start with a lowercase letter. Write in lowercase too.`,
    );
  } else if (lowerStart <= RARE) {
    rules.push('- They capitalize normally. Do the same.');
  }

  // Terminal punctuation — the single loudest "written by a bot" signal on X.
  const endsClean = share(posts, (post) => /[a-z0-9)"']$/i.test(post));

  if (endsClean >= STRONG) {
    rules.push(
      '- They almost never end a post with a full stop. Leave the final punctuation off.',
    );
  }

  // Length. The shortest posts matter more than the average: they show how
  // brief this person is willing to be, which is what models never risk.
  const lengths = posts.map(words).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  const shortest = lengths[0];

  rules.push(
    `- Their typical post runs about ${median} words, and their shortest are ${shortest}. ` +
      'Match that range, and do not pad a short thought into a full sentence.',
  );

  // Emoji and hashtags — stated in both directions, because "never use emoji"
  // is wrong for someone who uses them constantly.
  const emoji = share(posts, (post) => EMOJI.test(post));

  if (emoji <= RARE) {
    rules.push('- They do not use emoji. Use none.');
  } else if (emoji >= STRONG) {
    rules.push('- They use emoji freely, the way they do in the samples.');
  }

  if (share(posts, (post) => /#\w/.test(post)) <= RARE) {
    rules.push('- They do not use hashtags. Use none.');
  }

  // Exclamation marks read as enthusiasm-as-a-service when overused by an AI.
  if (share(posts, (post) => post.includes('!')) <= RARE) {
    rules.push('- They rarely use exclamation marks. Avoid them.');
  }

  // Fragments and lowercase "i" are strong human tells worth naming explicitly.
  if (share(posts, (post) => /\bi\b/.test(post)) >= 0.25) {
    rules.push('- They write "i" in lowercase. Do the same.');
  }

  return (
    'How the owner actually types, measured from their real posts. These are ' +
    `not suggestions, they are the format:\n${rules.join('\n')}`
  );
}
