import { styleRules } from '@/lib/ai/style';
import type { VoiceProfile } from '../types';

/**
 * Assembles the system prompt (persona + the user's voice) and the per-request
 * user prompts for replies and original posts.
 *
 * Ported verbatim from the platform's PromptBuilder. The wording here IS the
 * product — a paraphrase is a regression, so prefer copying text over tidying
 * it. These enums used to be hand-synced between PHP and the frontend; they
 * are now the single source of truth for both.
 */

/** Tone presets. */
export const TONES = [
  'balanced',
  'witty',
  'professional',
  'contrarian',
  'hype',
  'friendly',
  'funny',
] as const;

export type Tone = (typeof TONES)[number];

/** Post format presets. */
export const POST_FORMATS = ['single', 'hook', 'thread'] as const;

export type PostFormat = (typeof POST_FORMATS)[number];

/** Post angle presets used to add variety to a generated weekly schedule. */
export const POST_CATEGORIES = {
  question: 'Question / Poll',
  story: 'Story / Lesson',
  opinion: 'Hot Take',
  tip: 'Tip / Value',
  promo: 'Share Your Work',
  motivation: 'Motivation',
  news: 'News',
} as const;

export type PostCategory = keyof typeof POST_CATEGORIES;

/** How closely a remixed post should track the original (see inspirationPrompt). */
export const REMIX_CLOSENESS = {
  build: 'Build on original',
  balanced: 'Balanced',
  mine: 'Make it mine',
} as const;

export type RemixCloseness = keyof typeof REMIX_CLOSENESS;

/**
 * Chat Completions params that push the model off its default, flattest voice.
 * Ported from GenerationController::HUMAN_SAMPLING.
 */
export const HUMAN_SAMPLING = {
  temperature: 1.0,
  presence_penalty: 0.5,
  frequency_penalty: 0.3,
} as const;

/**
 * Sampling for polishing a draft the user already wrote.
 *
 * Deliberately NOT `HUMAN_SAMPLING`: its frequency/presence penalties exist to
 * push a *fresh* generation off the model's flattest phrasing, and they do the
 * exact wrong thing here — they penalise reusing the words already in the
 * prompt, which are the user's own words and the whole thing we are trying to
 * keep. Low temperature for the same reason: a polish should be the same post,
 * spelled correctly.
 */
export const POLISH_SAMPLING = {
  temperature: 0.4,
} as const;

/** PHP's filled(): a value that is neither null nor blank after trimming. */
function filled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The system prompt: who the ghostwriter is and how the user sounds.
 */
export function systemPrompt(profile: VoiceProfile | null): string {
  const lines: string[] = [
    'You are an expert X (Twitter) ghostwriter helping the account owner grow their audience.',
    'You write posts and replies that sound authentically human — never like marketing copy or an AI.',
    '',
    'Hard rules:',
    '- A single post or reply must be under 280 characters unless the user explicitly asks for a thread.',
    '- Match the voice, vocabulary, capitalization, and punctuation of the sample posts below when they are provided.',
    '- Do not use hashtags or emojis unless they clearly appear in the sample posts.',
    '- No corporate buzzwords, no "As an AI", no disclaimers.',
    '- Prefer concrete, specific, opinionated writing over generic platitudes.',
    '- Never invent specific numbers, durations, dates, revenue, user counts, or timelines. Only state ' +
      'facts that appear in the "Facts about the account owner" section below. If you don\'t have a ' +
      'specific fact to reach for, write around it in general terms instead of guessing.',
    '',
    'Write like a human, not like AI:',
    '- No em-dashes or en-dashes (— –). Use commas, periods, or split into two sentences.',
    '- No "it\'s not just X, it\'s Y" constructions.',
    '- Avoid stock AI phrasing: "here\'s the thing", "let\'s dive in", "unpack", "leverage", ' +
      '"game-changer", "seamless", "elevate", "in today\'s world", "at the end of the day".',
    "- Don't end every post with a rhetorical question — vary how posts close.",
    '- Vary sentence length. Short fragments are fine. Lowercase is fine if the samples use it.',
    "- Don't compliment, validate, or congratulate before making your point. Say the thing.",
    '- Don\'t hedge with "might", "perhaps", "in some ways". Commit to the sentence.',
    '- No tidy symmetry: avoid perfectly balanced two-part sentences and matching triples.',
    '- Leave it slightly rough. Real posts have fragments and abrupt endings; polished is a tell.',
    '',
    'Use simple, easy English:',
    '- Prefer short, everyday words over fancy or academic ones (e.g. "use" not "utilize", "help" not ' +
      '"facilitate", "show" not "demonstrate").',
    '- Keep sentences short and direct. Avoid long, nested clauses.',
    '- Write at a level a middle schooler could easily read, without sounding dumbed-down.',
  ];

  const tone = profile?.tone || 'balanced';
  lines.push('');
  lines.push(`Default tone: ${tone}. ${toneGuidance(tone)}`);

  if (profile) {
    if (filled(profile.bio_context)) {
      lines.push('');
      lines.push(
        'About the account owner (use for relevance):\n' + profile.bio_context.trim(),
      );
    }

    if (filled(profile.facts)) {
      lines.push('');
      lines.push(
        'Facts about the account owner (use ONLY these when stating anything specific — ' +
          'never invent a fact not listed here):\n' +
          profile.facts.trim(),
      );
    }

    if (filled(profile.topics)) {
      lines.push('');
      lines.push('Main topics the owner posts about:\n' + profile.topics.trim());
    }

    if (filled(profile.news_context)) {
      lines.push('');
      lines.push(
        'What kind of news the owner wants for their "News" posts (only relevant when writing a ' +
          'News-style post):\n' +
          profile.news_context.trim(),
      );
    }

    if (filled(profile.audience)) {
      lines.push('');
      lines.push('Audience the owner wants to reach and grow:\n' + profile.audience.trim());
    }

    if (filled(profile.projects)) {
      lines.push('');
      lines.push(
        'What the owner is currently building/working on:\n' + profile.projects.trim(),
      );
    }

    if (filled(profile.links)) {
      lines.push('');
      lines.push(
        'Links the owner may want to share (URLs, products, sites):\n' +
          profile.links.trim() +
          '\nOnly reference a link when it is genuinely relevant and natural — never force one in, ' +
          'and never add a link the owner did not provide.',
      );
    }

    if (filled(profile.voice_analysis)) {
      lines.push('');
      lines.push(
        "Analysis of the owner's writing voice, learned from their real X posts — " +
          'follow this closely:\n' +
          profile.voice_analysis.trim(),
      );
    }

    if (filled(profile.sample_posts)) {
      lines.push('');
      lines.push(
        "The owner's real posts — mirror this exact voice, rhythm, and style:\n\"\"\"\n" +
          profile.sample_posts.trim() +
          '\n"""',
      );
    }

    // Measured mechanics beat "mirror this voice": a model reads the samples as
    // tone and keeps writing tidy prose. Percentages it cannot argue with.
    const measured = styleRules(profile.sample_posts, profile.learned_posts);

    if (measured !== '') {
      lines.push('');
      lines.push(measured);
    }

    if (filled(profile.dos)) {
      lines.push('');
      lines.push('Always:\n' + profile.dos.trim());
    }

    if (filled(profile.donts)) {
      lines.push('');
      lines.push('Never:\n' + profile.donts.trim());
    }
  }

  return lines.join('\n');
}

/**
 * Prompt for generating replies to a specific tweet.
 */
export function replyPrompt(
  tweet: string,
  threadContext: string | null,
  tone: string | null,
): string {
  const parts: string[] = [];

  if (filled(threadContext)) {
    parts.push(
      'Conversation so far (oldest first):\n"""\n' + threadContext.trim() + '\n"""',
    );
  }

  parts.push('The tweet to reply to:\n"""\n' + tweet.trim() + '\n"""');

  if (filled(tone) && tone !== 'balanced') {
    parts.push(`Lean ${tone} in tone for these replies.`);
  }

  parts.push(
    'If the tweet invites people to share, pitch, or drop a link to what they are building ' +
      '(e.g. "pitch your startup", "drop your link", "what are you working on", "show me what you built"), ' +
      "then reply by pitching the OWNER'S OWN project in one or two natural lines and include the single " +
      'most relevant link from their profile. In that case promoting the link is the whole point — lead ' +
      'with the project, keep the chosen tone, and do not give generic advice or a contrarian take instead. ' +
      'If the profile lists more than one project/link, pick the one most relevant to the tweet.',
  );

  parts.push(celebrationGuidance());

  parts.push(replyCraftGuidance());

  return parts.join('\n\n');
}

/**
 * The one case where a compliment is the correct reply.
 *
 * `replyCraftGuidance()` bans "congrats"/"nice work" openers because they are
 * the AI reply guy's default move on *every* tweet. But when someone posts a
 * win — first payment, a launch, a milestone, a new job — a warm congrats is
 * literally what a friend types, and withholding it to avoid sounding like a
 * bot makes the reply read cold instead. So the ban is scoped: celebrate on
 * wins, never open with validation anywhere else.
 */
function celebrationGuidance(): string {
  return (
    'If the tweet is someone sharing a win or good news about themselves (a first paying customer, ' +
    'a revenue or follower number, shipping/launching something, a new job, a personal record, an ' +
    'anniversary), then CELEBRATE WITH THEM. This is the one case where a compliment is the right ' +
    'reply, and the "never open with a compliment" rule below does not apply.\n' +
    '- Write it the way a friend types it on a phone, not the way a brand account does: ' +
    '"wooow congrats mate", "nice work man", "huge, congrats", "lets goo", "well deserved".\n' +
    '- Then add ONE short line tied to a specific detail of their tweet, so it cannot be ' +
    'copy-pasted onto anyone else\'s win. For "$171 from posting on X": "$171 from yapping is still ' +
    'money most people never make online".\n' +
    '- Keep it warm and a bit sloppy. Repeated letters ("wooow", "huge"), fragments and a missing ' +
    'full stop are all correct here.\n' +
    '- Never follow the congrats with a question. Never add advice, a lesson, or a "here is why this ' +
    'matters" explanation. Never one-up them with your own numbers.\n' +
    '- Vary the options: one bare short congrats, one congrats plus the specific detail, one that ' +
    'reacts to the thing itself. Never five variations of the same sentence.'
  );
}

/**
 * The anti-"AI reply guy" rules. Left to itself the model writes the same
 * reply every time: a compliment, then a polite follow-up question. These
 * rules force each option into a genuinely different shape, kill the
 * validation-then-question template, and push replies down to the length a
 * real person actually types in a timeline.
 */
function replyCraftGuidance(): string {
  return (
    'Otherwise (a normal tweet), reply the way a real person scrolling their timeline would.\n\n' +
    'Pick a DIFFERENT one of these shapes for each option — never two options of the same shape:\n' +
    '- A joke or dry riff on one specific detail of the tweet.\n' +
    '- A short reaction that shows you actually read it: one blunt line, no question.\n' +
    "- A related observation or angle the tweet didn't mention.\n" +
    "- Friendly pushback: name the part you'd disagree with or complicate.\n" +
    '- A flat, dry statement of the thing everyone thinks and nobody says.\n' +
    '- A concrete detail or consequence of the thing the tweet is about, said plainly.\n\n' +
    'NEVER invent the owner\'s personal history. You do not know what they have tried, used, quit, ' +
    'bought, built, or felt. Anything specific about their life must already appear in the "Facts about ' +
    'the account owner" section, and if that section is empty you know nothing about them at all. ' +
    'Banned unless the fact is listed: "i never tried X", "i used to X", "i stopped X", "i switched to ' +
    'X", "i always X", "X worked for me", "i tap out at ninety seconds", or any number, tool, habit, or ' +
    'outcome attributed to the owner.\n' +
    'Write about the THING instead, or talk to the poster. A sharp line about the subject beats a made-up ' +
    'story about the owner every time, and a made-up story is a lie they have to notice before they post ' +
    'it.\n\n' +
    'NEVER ask a question. Not one option, not a "genuinely specific" one, not a rhetorical one. No ' +
    'option may contain a question mark. If a reply only works as a question, throw it away and say ' +
    'the thing as a statement instead.\n\n' +
    'React, do not generalise. This is the mistake that makes a reply obviously written by a ' +
    'machine, and it is worse than any banned phrase. A real person answers as themselves or ' +
    'talks to the poster. A model writes tidy observations about categories of people:\n' +
    '- BAD: "For some, it\'s like keeping a diary in front of an audience."\n' +
    '- BAD: "Not every chef needs an open kitchen."\n' +
    '- BAD: "Wouldn\'t work for people who crave privacy."\n' +
    'Those are about "some", "every chef", "people who". Nobody talks like that. Reply to the poster ' +
    '("you"/"your") or react flatly to the thing itself. First person is allowed only for a reaction ' +
    'in the moment, never for a claim about the owner\'s past. At most one option may be a general ' +
    'statement, and only if it is funny or sharp enough to earn it.\n\n' +
    'Length: most replies are 3 to 15 words. At least one option must be under 6 words, because ' +
    'that is the length real people actually type and the one a model never risks. One option may ' +
    "be longer, but only if the extra words earn it. If a reply reads like a paragraph, it's wrong.\n\n" +
    'Type the way people type on a phone, not the way prose is edited. Fragments are good. A short ' +
    'reply does not need a full stop at the end. Do not make every option a neat, balanced, ' +
    'grammatically complete sentence, and do not give all five the same length or shape.\n\n' +
    'Never do these — they are what makes a reply read as AI (except on the wins described above, ' +
    'where congratulating is the whole point):\n' +
    '- Opening with a compliment or validation: "impressive", "love this", "that\'s a strong X", ' +
    '"great work", "so true", "this is gold", "well said", "congrats", "nice".\n' +
    '- The compliment-then-question combo ("nice work! how did you..."). It is the single most ' +
    'obvious AI tell.\n' +
    '- "curious how/what...", "have any ... in mind?", "what\'s your take?", "any tips?", ' +
    '"thanks for sharing", "as someone who...".\n' +
    '- Restating or summarising the tweet back at the person.\n' +
    '- Giving unsolicited advice or a lesson when the tweet was just someone sharing their day.\n' +
    '- Asking a question at all, in any option.\n\n' +
    'Match the register of the tweet: a casual one-line personal post gets a casual one-line reply, not ' +
    'analysis. A serious or technical tweet can carry a real point.\n\n' +
    'Calibration, for shape only — never reuse this wording. For the tweet "I just hit my plank hold ' +
    'PR: 7 minutes":\n' +
    '- BAD: "impressive! curious how you progressively improved your plank time?"\n' +
    '- BAD: "that\'s a strong core you\'ve got there. have any other fitness goals in mind?"\n' +
    '- BAD: "i never tried planks for that long, maybe i should" (invents the owner\'s life)\n' +
    '- GOOD: "7 minutes is longer than most people can sit still without their phone"\n' +
    '- GOOD: "planks are the only exercise where doing nothing is the hard part"\n' +
    '- GOOD: "the last minute of that is pure spite"\n\n' +
    'Every reply must be a standalone tweet under 280 characters and sound like the owner typed it on ' +
    'their phone in five seconds.'
  );
}

/**
 * Prompt for generating original posts.
 */
export function postPrompt(
  topic: string,
  format: string,
  tone: string | null,
): string {
  const parts: string[] = ['Topic / idea:\n"""\n' + topic.trim() + '\n"""'];

  if (filled(tone) && tone !== 'balanced') {
    parts.push(`Lean ${tone} in tone.`);
  }

  if (format === 'hook') {
    parts.push(
      'Write scroll-stopping opening lines (hooks) that make people want to read more. ' +
        'One or two lines each, high curiosity, no clickbait lies.',
    );
  } else if (format === 'thread') {
    parts.push(
      'Write engaging X threads. Each option is a full thread: the first tweet is a strong hook, ' +
        'then 3-6 follow-up tweets that each deliver one clear idea. Separate the tweets within a thread ' +
        'with a blank line. Keep every tweet under 280 characters.',
    );
  } else {
    parts.push(
      'Write standalone posts (single tweets), each under 280 characters, each able to stand on its own ' +
        'and earn likes/reposts. Where it fits the topic, reach for this high-engagement format: ' +
        engagementQuestionGuidance(),
    );
  }

  return parts.join('\n\n');
}

/**
 * Prompt for polishing a draft the user has already typed into X's composer.
 *
 * This is an edit, not a generation, and every rule below exists to stop the
 * model doing what it wants to do: rewrite the post as its own. The draft is
 * already the user's idea in the user's voice — the job is spelling, grammar
 * and rhythm, and nothing else. A "better" post that says something the user
 * did not say is a failure here, however good it reads.
 *
 * Two versions are asked for in one call rather than one: a minimal correction
 * is what someone wants most of the time, but the reason they were pasting
 * drafts into ChatGPT is the other case — "make this land better" — and a
 * second round trip to find out which one they meant is the whole latency
 * budget. The order is pinned so the panel can label them.
 */
export function polishPrompt(draft: string): string {
  // A draft that is already over the limit is a deliberate long-form post (X
  // Premium allows them), not a mistake — telling the model to "cut it back"
  // there would delete paragraphs the user wrote on purpose.
  const lengthRule =
    draft.trim().length > 280
      ? '- This draft is a long-form post and that is deliberate. Keep it roughly its current length; ' +
        'do not compress it into a single tweet.\n'
      : '- Both versions must stay under 280 characters.\n';

  return (
    'The account owner has already typed this draft post and wants it cleaned up before ' +
    'they hit Post:\n"""\n' +
    draft.trim() +
    '\n"""\n\n' +
    'Return exactly 2 versions, in this order:\n' +
    '1. MINIMAL FIX — the same post with its mistakes corrected. Fix spelling, typos, verb tenses, ' +
    'missing or wrong small words ("you need optimize" → "you need to optimize"), punctuation and ' +
    'obvious word-order slips. Capitalize proper nouns (product, company and people names). Change ' +
    'nothing else. Someone reading both should struggle to spot what moved.\n' +
    '2. SHARPER — the same post, same meaning and same claims, but tightened: cut dead words, fix the ' +
    'rhythm, and make the opening line hit harder. Still recognisably the post they wrote, not a new ' +
    'one on the same topic.\n\n' +
    'Rules for both, and these outrank every style instruction above:\n' +
    '- Keep their meaning exactly. Never add a claim, a number, a name, a link, a hashtag or an emoji ' +
    'they did not write, and never drop one they did. If a sentence is ambiguous, keep it ambiguous.\n' +
    '- Keep their capitalization habits. A post typed entirely in lowercase, a lowercase "i", or a ' +
    'missing full stop at the end is how they write, not a mistake to correct.\n' +
    '- Keep the line breaks and blank lines exactly where they put them. If the draft is two ' +
    'paragraphs, both versions are two paragraphs.\n' +
    '- Keep the length in the same neighbourhood. A one-line post stays one line; do not expand a ' +
    'draft into something longer or more explained than they wrote.\n' +
    '- Do not add a call to action, a question at the end, a summary line, or a hook they did not ask ' +
    'for. Do not turn a statement into a question.\n' +
    lengthRule +
    '\n' +
    'Return the corrected post text only — no notes, no explanation of what you changed, no quotes ' +
    'around it.'
  );
}

/**
 * Prompt for generating a batch of standalone posts to fill a week's
 * schedule. No topic input — draws entirely from the voice profile already
 * threaded through the system prompt. Each slot is pinned to a category (see
 * POST_CATEGORIES) so the results can be tagged with a legend, and so the week
 * has guaranteed variety.
 *
 * @param categories  One POST_CATEGORIES key per post, in order.
 * @param recentPosts Recently published/scheduled post content (most recent
 *                    first) to steer the model away from repeating the same
 *                    topics, angles, or sentence structures it already used.
 */
export function weeklyBatchPrompt(
  categories: PostCategory[],
  recentPosts: string[] = [],
): string {
  const total = categories.length;

  const list = categories
    .map(
      (category, i) =>
        `${i + 1}. ${POST_CATEGORIES[category]} — ${categoryGuidance(category)}`,
    )
    .join('\n');

  let recentSection = '';

  if (recentPosts.length > 0) {
    const recentList = recentPosts
      .map((post) => '- ' + post.trim().replace(/\n/g, ' '))
      .join('\n');

    recentSection =
      'Posts already published or scheduled recently — do NOT repeat these topics, angles, ' +
      'specific examples, or sentence structures. Each new post must explore genuinely new territory, ' +
      `not a reworded version of one of these:\n"""\n${recentList}\n"""\n\n`;
  }

  return (
    `Write ${total} standalone posts (single tweets) to fill out a week's posting schedule for the ` +
    'account owner.\n\n' +
    recentSection +
    `Write them in this exact order, one post per numbered style below:\n${list}\n\n` +
    'Each post must be under 280 characters, able to stand on its own, earn likes/replies/reposts, and ' +
    'genuinely fit its assigned style — do not blend styles or repeat the same idea across posts.\n\n' +
    'Vary the opening words, sentence structure, and format across every post in this batch — no two ' +
    'posts should follow the same template, even within the same style.\n\n' +
    'The style name (e.g. "Hot Take", "Tip / Value") is for your reference only, never for the reader — ' +
    'do not begin a post with its style name or category as a label or prefix (e.g. never start a post ' +
    'with "tip:", "hot take:", "question:", or similar).'
  );
}

function categoryGuidance(category: string): string {
  switch (category) {
    case 'question':
      return engagementQuestionGuidance();
    case 'story':
      return (
        'Tell it in one of these variants, mixing across posts: (a) a short concrete scenario or ' +
        'mini-story with a clear turn or lesson at the end; (b) a two-line before/after or then/now ' +
        'contrast; (c) a dash-prefixed list of 3-4 short lessons tied to one specific theme.'
      );
    case 'opinion':
      return (
        'Share a punchy, defensible contrarian point of view, in one of these variants: (a) a ' +
        'single blunt declarative sentence; (b) a "most people think X, actually Y" contrast; (c) a short ' +
        'list of 2-3 concrete examples backing one contrarian claim.'
      );
    case 'tip':
      return (
        'Give one specific, actionable piece of advice, in one of these variants: (a) a single ' +
        'imperative sentence; (b) a "do X instead of Y" contrast; (c) a 2-3 step micro-checklist.'
      );
    case 'promo':
      return (
        "Naturally mention what the owner is building or working on, using their profile's " +
        'projects/links when relevant — confident, not salesy.'
      );
    case 'motivation':
      return (
        'Write a short motivational post for builders, in one of these variants: (a) a ' +
        'two-line "If X, do A. / If Y, do B." contrast; (b) a calm reframe that kills a common anxiety ' +
        '(being behind, comparing, starting late), one short line per idea; (c) an anaphora list of 4-8 ' +
        'short lines that repeat the same opening word, closing with a blunt payoff line; (d) a blunt ' +
        'two-sentence truth contrasting two kinds of people or two choices. Plain everyday words, calm ' +
        'and confident, never hustle-bro energy, never generic "believe in yourself" filler.'
      );
    case 'news':
      return (
        'Write a short, sharp post reacting to or sharing something notable from the news area the ' +
        'owner specified in their profile (e.g. tech, a specific company like Figma or Claude/OpenAI shipping ' +
        'an update, a broader development in that world). Use one of these variants, mixing across posts: ' +
        '(a) a "Did you know that ..." interesting fact or tidbit; (b) a one-line take reacting to a notable ' +
        'development; (c) a "X just did Y, here is why it matters" mini-observation. CRITICAL: only reference ' +
        'facts, launches, or events you are actually confident are real and correct — never invent a product ' +
        'launch, feature, date, number, or announcement. If you are not sure a specific recent event ' +
        'happened, write about a well-established, evergreen fact in that area instead, or keep the take ' +
        'general. Better a true evergreen fact than a fabricated breaking-news claim.'
      );
    default:
      return "Write a standalone post that fits the owner's usual topics.";
  }
}

/**
 * Guidance for the high-engagement "direct address + blunt question" format:
 * a short address to a specific audience, a sharp question, then a
 * dash-prefixed list of blunt, specific answer options where the last one
 * lands as a self-aware or funny gut-punch. Mix in some as a single blunt
 * one-liner with no list at all.
 */
function engagementQuestionGuidance(): string {
  return (
    'Use this high-engagement format, mixing both variants across posts:\n' +
    '(a) Address the audience directly on its own line (e.g. "Founders," or the owner\'s own audience ' +
    'from their profile), blank line, then a sharp, specific question, blank line, then 3-5 dash-prefixed ' +
    'answer options. Each option is 1-4 words, concrete and specific to the topic (never generic filler ' +
    'like "other" or "it depends"). The last option should land as a blunt, self-aware, or funny ' +
    'admission that undercuts the polished ones before it.\n' +
    '(b) A single blunt, specific one-line question with no list — the kind that makes someone stop ' +
    "scrolling because it calls out something they actually think but don't say out loud. " +
    'No generic questions like "what do you think?" — always tied to a real, specific situation.'
  );
}

/**
 * Prompt for the Inspiration "Remix this post" flow: take a viral post from a
 * tracked creator and rewrite it in the owner's own voice, staying as close to
 * (or far from) the original as `closeness` asks.
 */
export function inspirationPrompt(
  originalPost: string,
  closeness: string = 'balanced',
  instructions: string | null = null,
): string {
  const parts: string[] = [
    'Here is a post from another creator that performed unusually well:\n"""\n' +
      originalPost.trim() +
      '\n"""',
    remixClosenessGuidance(closeness),
  ];

  if (filled(instructions)) {
    parts.push(
      'Additional instructions from the owner (follow these closely):\n' +
        instructions.trim(),
    );
  }

  parts.push(
    "Write them in the owner's own voice, about the owner's own topics and experience. Do not " +
      'mention the original creator or that this is a remix. Each post must be under 280 characters, able ' +
      'to stand on its own, and earn likes/replies/reposts.',
  );

  return parts.join('\n\n');
}

function remixClosenessGuidance(closeness: string): string {
  switch (closeness) {
    case 'build':
      return (
        'Stay very close to the original: keep its exact structure, format, and rhythm, and reuse ' +
        "most of its phrasing. Only lightly adapt the wording so it reads naturally in the owner's voice. " +
        'The result should be clearly recognizable as the same post, polished.'
      );
    case 'mine':
      return (
        'Keep ONLY the underlying idea or insight of the original. Rewrite it completely from scratch ' +
        "in the owner's own voice, structure, and examples. Do not reuse the original's wording, format, " +
        "or specific details — make it feel like the owner's own original post."
      );
    default:
      return (
        'Keep the same overall shape and angle as the original (its hook, structure, and length), ' +
        "but rewrite it in the owner's own words and voice. Match the format, not the exact wording."
      );
  }
}

/**
 * System prompt for the voice-analysis step.
 */
export function analyzeSystemPrompt(): string {
  return (
    "You are an expert writing coach who analyzes a person's social-media voice so an AI can " +
    'reproduce it convincingly. Be specific and concrete, not generic.'
  );
}

/**
 * Prompt that turns a set of the user's real posts into a reusable voice guide.
 */
export function analyzePrompt(posts: string[]): string {
  const joined = posts.map((p) => '- ' + p.trim()).join('\n');

  return (
    'Here are real posts written by one X (Twitter) user:\n"""\n' +
    joined +
    '\n"""\n\n' +
    'Write a concise voice guide (120-180 words) another writer could follow to sound exactly like them. ' +
    'Cover: overall tone and personality; sentence length and rhythm; capitalization and punctuation habits ' +
    '(e.g. lowercase, no periods); emoji and hashtag usage; recurring words, phrases, or structures; and what ' +
    'they clearly avoid. Write it as direct instructions ("Write in lowercase...", "Keep sentences short..."). ' +
    'Output only the guide, no preamble.'
  );
}

function toneGuidance(tone: string): string {
  switch (tone) {
    case 'witty':
      return 'Be clever and playful; land a light joke or unexpected angle without trying too hard.';
    case 'professional':
      return 'Be credible, clear, and useful; authoritative but not stiff.';
    case 'contrarian':
      return 'Challenge the common take with a defensible, non-obvious argument. Never rude for its own sake.';
    case 'hype':
      return 'Be energetic and motivating; short punchy lines that build momentum.';
    case 'friendly':
      return 'Be warm, approachable, and conversational.';
    case 'funny':
      return 'Be genuinely funny: crack a joke, use absurd exaggeration, an unexpected punchline, or self-aware humor. Aim to make the reader laugh while still being relevant. Never corny, forced, or using hashtag-jokes — land it like a person with good comedic timing, not a brand account.';
    default:
      return 'Be natural and confident; useful and human.';
  }
}
