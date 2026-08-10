/**
 * Enforcement for the reply rules `replyCraftGuidance()` states in the prompt.
 *
 * The prompt already forbids compliment openers, the "curious how…" family,
 * restating the tweet, and more than one question. Models ignore it anyway —
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

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Whether a whole set still reads as machine output, even if each option passed
 * on its own. Two failures only show up across the set, not per option:
 * everything being third-person, and everything being the same length.
 */
export function setProblems(options: string[]): string[] {
  const problems: string[] = [];

  if (options.length < 2) return problems;

  if (!options.some((option) => FIRST_OR_SECOND.test(option))) {
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
 * Drop the options that break the rules, keeping at most one question.
 *
 * Order is preserved, and the first question survives — the prompt does allow
 * one, it is only the "every option is a question" pattern that reads as AI.
 */
export function screenReplies(options: string[], tweet: string): Screening {
  const kept: string[] = [];
  const rejected: Rejection[] = [];
  let questions = 0;

  for (const option of options) {
    const text = option.trim();

    if (text === '') continue;

    const phrase = PHRASES.find((entry) => entry.pattern.test(text));

    if (OPENERS.test(text)) {
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

    if (text.endsWith('?')) {
      questions++;

      if (questions > 1) {
        rejected.push({ option: text, reason: 'more than one option was a question' });
        continue;
      }
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
      'and do not reuse their wording or their shape. Answer as the owner ' +
      'reacting in first person, or speak directly to the poster. Make at least ' +
      'one of them under six words. Reach for the shapes that were missing: a dry ' +
      'joke about one specific detail, a blunt reaction with no question, an angle ' +
      'the tweet did not mention, or friendly pushback.',
  );

  return parts.join('\n\n');
}
