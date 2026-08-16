/**
 * Enforcement for the reply rules `replyCraftGuidance()` states in the prompt.
 *
 * The prompt already forbids compliment openers, the "curious how…" family,
 * restating the tweet, and questions of any kind. Models ignore it anyway —
 * a real generation came back with "Agreed. Not every chef needs an open
 * kitchen", "Wouldn't work for people who crave privacy in solo projects" and
 * "But isn't the feedback valuable even for the hesitant ones?", which is three
 * violations out of five.
 *
 * So the rules are checked here too. This is the same belt-and-braces reflex as
 * `stripDashes()`: say it in the prompt, then verify it in code.
 */

export interface Rejection {
  option: string;
  reason: string;
}

export interface Screening {
  kept: string[];
  rejected: Rejection[];
}

/** Validation/agreement openers. The single most obvious AI tell. */
const OPENERS =
  /^\s*(?:oh\s+)?(?:impressive|love this|love it|great (?:work|point|take|thread)|so true|this is (?:gold|great|so true)|well said|congrats|congratulations|nice(?: one)?|agreed|absolutely|exactly|facts|100%|couldn't agree|totally agree|this\.|underrated take|solid (?:point|take)|wow[,.! ]|honestly this|this right here|so much this|big mood|felt this|preach\b|couldn't have said)/i;

/** Phrases the prompt names outright. */
const PHRASES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(?:curious|wondering|always wondered)\s+(?:how|what|why|if)\b/i, reason: 'the "curious how…" opener' },
  { pattern: /\bhave any\b.*\bin mind\b/i, reason: '"have any … in mind?"' },
  { pattern: /\bwhat'?s your take\b/i, reason: '"what\'s your take?"' },
  { pattern: /\bany tips\b/i, reason: '"any tips?"' },
  { pattern: /\bthanks for sharing\b/i, reason: '"thanks for sharing"' },
  { pattern: /\bas someone who\b/i, reason: '"as someone who…"' },
  { pattern: /\bwhat do you think\b/i, reason: '"what do you think?"' },
  { pattern: /\bgame[- ]changer\b/i, reason: '"game-changer"' },
  { pattern: /\bthis is (?:so )?relatable\b/i, reason: '"this is relatable"' },
  { pattern: /\bwe'?ve all been there\b/i, reason: '"we\'ve all been there"' },
  { pattern: /\bliving rent[- ]free\b/i, reason: '"living rent-free"' },
  { pattern: /\bchef'?s kiss\b/i, reason: '"chef\'s kiss"' },
  { pattern: /\btook the words (?:right )?out of my mouth\b/i, reason: '"took the words out of my mouth"' },
  { pattern: /\bthe real question is\b/i, reason: '"the real question is"' },
  { pattern: /\bsay it louder\b/i, reason: '"say it louder"' },
  { pattern: /\bhits different\b/i, reason: '"hits different"' },
  { pattern: /\bcan'?t help but\b/i, reason: '"can\'t help but"' },
  { pattern: /\bmore people need to (?:hear|see|say) this\b/i, reason: '"more people need to hear this"' },
];

/** Words too common to count as evidence that a reply echoes the tweet. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'you', 'your', 'i', 'my', 'we', 'our',
  'not', 'no', 'do', 'does', 'did', 'so', 'just', 'can', 'will', 'would',
  'they', 'their', 'them', 'he', 'she', 'his', 'her', 'about', 'what', 'how',
]);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).filter(
    (word) => word.length > 2 && !STOP.has(word),
  );
}

/**
 * Does the reply mostly repeat the tweet's own words?
 *
 * Conservative on purpose: short replies are exempt (a 4-word riff shares words
 * with anything) and the bar is high, because a false positive throws away a
 * reply the user might have liked.
 */
function restatesTweet(option: string, tweet: string): boolean {
  const words = contentWords(option);

  if (words.length < 5) return false;

  const source = new Set(contentWords(tweet));

  if (source.size === 0) return false;

  const echoed = words.filter((word) => source.has(word)).length;

  return echoed / words.length >= 0.6;
}

/**
 * Openers that announce a generalisation about a category of people.
 *
 * This is the pattern behind the worst real output we saw — all five options
 * were observations about "some", "every chef", "people who", "the hesitant
 * ones", "founders". Nobody replies like that; it is the single clearest sign
 * a machine wrote it.
 */
const GENERALISING =
  /^\s*(?:for some|for many|for a lot of|not every|not everyone|not all|most people|some people|a lot of people|people who|everyone who|anyone who|those who|there are people)\b/i;

const FIRST_OR_SECOND = /\b(?:i|i'm|i've|i'd|ive|im|me|my|mine|you|you're|your|yours|youre|we|us|our)\b/i;

/**
 * Is the tweet someone sharing a win?
 *
 * The compliment ban exists because "congrats! how did you do it?" is the AI
 * reply guy's move on every tweet. On an actual win it is the *correct* reply,
 * so the screener has to know the difference or it throws away exactly the
 * replies the user wanted. Deliberately keyword-based rather than a second
 * model call: this runs on the critical path of a mid-scroll generation, and a
 * false negative only costs a warm opener, not a broken reply.
 */
export function isCelebration(tweet: string): boolean {
  return CELEBRATION.test(tweet);
}

/**
 * First-person claims about the owner's past that the model has no way to know.
 *
 * "never tried instagram for plugin sales, maybe i should" is the failure this
 * exists for: fluent, in-voice, and a straight invention the user has to catch
 * before they post it. A generalising reply is embarrassing; a fabricated
 * autobiography is a lie in their own timeline, so this is the stricter check.
 *
 * Present-tense reactions ("i love this", "i'm using that") are left alone —
 * only the past-tense/habitual shapes that assert history are caught.
 *
 * The elided subject matters as much as the explicit one: the reply that
 * prompted this was "never tried instagram for plugin sales, maybe i should",
 * which asserts a fact about the owner without ever typing "I".
 */
const EXPERIENCE_VERBS =
  'tried|used|switched|quit|stopped|started|built|shipped|bought|sold|paid|charged|tested|ran|wrote|learned|left|joined|hired|fired|lost|earned|made';

const INVENTED_EXPERIENCE = new RegExp(
  [
    // "i never tried…", "we built…", "i used to…"
    `\\b(?:i|we)\\s+(?:(?:have\\s+)?never|always|used\\s+to|still|finally|just|once|already)?\\s*(?:${EXPERIENCE_VERBS})\\b`,
    // Same claim with the subject dropped, the way people actually type it.
    `^\\s*(?:honestly\\s+|still\\s+)?(?:never|always|used\\s+to|once)\\s+(?:${EXPERIENCE_VERBS})\\b`,
    // "used to …" is autobiography whatever verb follows it.
    '\\b(?:i\\s+)?used\\s+to\\s+\\w+',
    "\\bi'?ve\\s+(?:never|always|been|tried|used|done)\\b",
    '\\bworked\\s+for\\s+me\\b',
    '\\bin\\s+my\\s+experience\\b',
    '\\bwhen\\s+i\\s+(?:was|did|had|tried|built|started)\\b',
  ].join('|'),
  'i',
);

const CELEBRATION =
  /\b(?:just (?:hit|shipped|launched|landed|closed|got|finished|passed|crossed)|i (?:hit|shipped|launched|got paid|landed|got|reached|crossed|finished)|we (?:hit|shipped|launched|raised|closed|crossed)|got paid|first (?:paying )?(?:customer|client|sale|user|dollar|payment|\$)|hit (?:my|our|\d)|crossed \$?\d|reached \$?\d|milestone|new (?:job|role|record|pr\b)|so grateful|excited to (?:share|announce)|happy to (?:share|announce)|proud to|finally (?:shipped|launched|done|finished)|\bmrr\b|\barr\b|anniversary|graduated|accepted (?:into|to)|went live|is live\b|shipped it)/i;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Whether a whole set still reads as machine output, even if each option passed
 * on its own. Two failures only show up across the set, not per option:
 * everything being third-person, and everything being the same length.
 */
export function setProblems(options: string[], tweet = ''): string[] {
  const problems: string[] = [];

  if (options.length < 2) return problems;

  // "wooow congrats mate" is the right reply to a win and contains neither an
  // "I" nor a "you". Demanding one there would force a pointless repair call.
  const celebrating = isCelebration(tweet);

  if (!celebrating && !options.some((option) => FIRST_OR_SECOND.test(option))) {
    problems.push(
      'not one option spoke as "I" or to "you" — they were all observations about other people',
    );
  }

  if (!options.some((option) => wordCount(option) < 6)) {
    problems.push(
      'every option was a full sentence; none was the short, blunt kind a real person actually types',
    );
  }

  return problems;
}

/**
 * Drop the options that break the rules.
 *
 * Two rules are absolute: no questions (the user does not want reply-guy
 * questions, so a question mark is a rejection, not a quota), and no
 * compliment openers — except when the tweet is a win, where a congrats is the
 * reply the user asked for and the opener check is skipped.
 */
export function screenReplies(options: string[], tweet: string): Screening {
  const kept: string[] = [];
  const rejected: Rejection[] = [];
  const celebrating = isCelebration(tweet);

  for (const option of options) {
    const text = option.trim();

    if (text === '') continue;

    const phrase = PHRASES.find((entry) => entry.pattern.test(text));

    if (!celebrating && OPENERS.test(text)) {
      rejected.push({ option: text, reason: 'it opens with agreement or a compliment' });
      continue;
    }

    if (phrase) {
      rejected.push({ option: text, reason: `it uses ${phrase.reason}` });
      continue;
    }

    if (GENERALISING.test(text)) {
      rejected.push({
        option: text,
        reason:
          'it is an observation about a category of people rather than a reaction',
      });
      continue;
    }

    if (restatesTweet(text, tweet)) {
      rejected.push({ option: text, reason: 'it restates the tweet back at them' });
      continue;
    }

    if (INVENTED_EXPERIENCE.test(text)) {
      rejected.push({
        option: text,
        reason:
          "it invents something about the owner's own life, which the model cannot know",
      });
      continue;
    }

    if (text.includes('?')) {
      rejected.push({ option: text, reason: 'it asks a question, and replies must never ask one' });
      continue;
    }

    kept.push(text);
  }

  return { kept, rejected };
}

/**
 * Order surviving replies by how human they read, best first.
 *
 * This exists because we over-generate: the model is asked for more options
 * than the panel shows, and this decides which ones make the cut. The score
 * rewards exactly what the prompt asks for and models under-deliver: short,
 * spoken in first/second person, not a question. The sort is stable, so
 * options the heuristic can't separate keep the model's original order.
 */
export function rankReplies(options: string[]): string[] {
  const score = (option: string): number => {
    const length = wordCount(option);
    let value = 0;

    if (length < 6) value += 2;
    else if (length <= 15) value += 1;

    if (length > 25) value -= Math.ceil((length - 25) / 10);

    if (FIRST_OR_SECOND.test(option)) value += 1;

    if (option.trim().endsWith('?')) value -= 1;

    return value;
  };

  return options
    .map((option, index) => ({ option, index, value: score(option) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((entry) => entry.option);
}

/**
 * The extra instruction for a repair call, naming what was thrown away and why.
 * Showing the model its own rejected attempts works far better than repeating
 * the rules it just ignored.
 */
export function repairPrompt(
  rejected: Rejection[],
  needed: number,
  problems: string[] = [],
): string {
  const parts: string[] = [];

  if (rejected.length > 0) {
    parts.push(
      'Your previous attempt produced replies that broke the rules:\n' +
        rejected
          .map((entry) => `- "${entry.option}" — rejected because ${entry.reason}.`)
          .join('\n'),
    );
  }

  if (problems.length > 0) {
    parts.push(
      'Taken as a set it also failed because ' + problems.join(', and ') + '.',
    );
  }

  parts.push(
    `Write ${needed} completely different replies. Do not repeat those mistakes, ` +
      'and do not reuse their wording or their shape. None of them may contain a ' +
      'question mark, and none may claim anything about the owner\'s own past — ' +
      'no "i tried", "i used to", "i never". Speak directly to the poster, or ' +
      'react flatly to the thing itself. Make at least one of them under six words. Reach ' +
      'for the shapes that were missing: a dry joke about one specific detail, a ' +
      'blunt reaction, an angle the tweet did not mention, or friendly pushback. ' +
      'If the tweet was someone sharing a win, congratulate them warmly instead, ' +
      'the way a friend would type it.',
  );

  return parts.join('\n\n');
}
