<?php

namespace App\Services;

use App\Models\VoiceProfile;

/**
 * Assembles the system prompt (persona + the user's voice) and the per-request
 * user prompts for replies and original posts.
 */
class PromptBuilder
{
    /** Tone presets exposed to the extension. */
    public const TONES = ['balanced', 'witty', 'professional', 'contrarian', 'hype', 'friendly', 'funny'];

    /** Post format presets. */
    public const POST_FORMATS = ['single', 'hook', 'thread'];

    /** Post angle presets used to add variety to a generated weekly schedule. */
    public const POST_CATEGORIES = [
        'question' => 'Question / Poll',
        'story' => 'Story / Lesson',
        'opinion' => 'Hot Take',
        'tip' => 'Tip / Value',
        'promo' => 'Share Your Work',
        'motivation' => 'Motivation',
        'news' => 'News',
    ];

    /**
     * The system prompt: who the ghostwriter is and how the user sounds.
     */
    public function systemPrompt(?VoiceProfile $profile): string
    {
        $lines = [
            'You are an expert X (Twitter) ghostwriter helping the account owner grow their audience.',
            'You write posts and replies that sound authentically human — never like marketing copy or an AI.',
            '',
            'Hard rules:',
            '- A single post or reply must be under 280 characters unless the user explicitly asks for a thread.',
            '- Match the voice, vocabulary, capitalization, and punctuation of the sample posts below when they are provided.',
            '- Do not use hashtags or emojis unless they clearly appear in the sample posts.',
            '- No corporate buzzwords, no "As an AI", no disclaimers.',
            '- Prefer concrete, specific, opinionated writing over generic platitudes.',
            '- Never invent specific numbers, durations, dates, revenue, user counts, or timelines. Only state '
                .'facts that appear in the "Facts about the account owner" section below. If you don\'t have a '
                .'specific fact to reach for, write around it in general terms instead of guessing.',
            '',
            'Write like a human, not like AI:',
            '- No em-dashes or en-dashes (— –). Use commas, periods, or split into two sentences.',
            '- No "it\'s not just X, it\'s Y" constructions.',
            '- Avoid stock AI phrasing: "here\'s the thing", "let\'s dive in", "unpack", "leverage", '
                .'"game-changer", "seamless", "elevate", "in today\'s world", "at the end of the day".',
            '- Don\'t end every post with a rhetorical question — vary how posts close.',
            '- Vary sentence length. Short fragments are fine. Lowercase is fine if the samples use it.',
            '',
            'Use simple, easy English:',
            '- Prefer short, everyday words over fancy or academic ones (e.g. "use" not "utilize", "help" not '
                .'"facilitate", "show" not "demonstrate").',
            '- Keep sentences short and direct. Avoid long, nested clauses.',
            '- Write at a level a middle schooler could easily read, without sounding dumbed-down.',
        ];

        $tone = $profile?->tone ?: 'balanced';
        $lines[] = '';
        $lines[] = 'Default tone: '.$tone.'. '.$this->toneGuidance($tone);

        if ($profile) {
            if (filled($profile->bio_context)) {
                $lines[] = '';
                $lines[] = "About the account owner (use for relevance):\n".trim($profile->bio_context);
            }

            if (filled($profile->facts)) {
                $lines[] = '';
                $lines[] = 'Facts about the account owner (use ONLY these when stating anything specific — '
                    ."never invent a fact not listed here):\n".trim($profile->facts);
            }

            if (filled($profile->topics)) {
                $lines[] = '';
                $lines[] = "Main topics the owner posts about:\n".trim($profile->topics);
            }

            if (filled($profile->news_context)) {
                $lines[] = '';
                $lines[] = 'What kind of news the owner wants for their "News" posts (only relevant when writing a '
                    ."News-style post):\n".trim($profile->news_context);
            }

            if (filled($profile->audience)) {
                $lines[] = '';
                $lines[] = "Audience the owner wants to reach and grow:\n".trim($profile->audience);
            }

            if (filled($profile->projects)) {
                $lines[] = '';
                $lines[] = "What the owner is currently building/working on:\n".trim($profile->projects);
            }

            if (filled($profile->links)) {
                $lines[] = '';
                $lines[] = "Links the owner may want to share (URLs, products, sites):\n".trim($profile->links)
                    ."\nOnly reference a link when it is genuinely relevant and natural — never force one in, "
                    .'and never add a link the owner did not provide.';
            }

            if (filled($profile->voice_analysis)) {
                $lines[] = '';
                $lines[] = "Analysis of the owner's writing voice, learned from their real X posts — "
                    ."follow this closely:\n".trim($profile->voice_analysis);
            }

            if (filled($profile->sample_posts)) {
                $lines[] = '';
                $lines[] = "The owner's real posts — mirror this exact voice, rhythm, and style:\n\"\"\"\n"
                    .trim($profile->sample_posts)."\n\"\"\"";
            }

            if (filled($profile->dos)) {
                $lines[] = '';
                $lines[] = "Always:\n".trim($profile->dos);
            }

            if (filled($profile->donts)) {
                $lines[] = '';
                $lines[] = "Never:\n".trim($profile->donts);
            }
        }

        return implode("\n", $lines);
    }

    /**
     * Prompt for generating replies to a specific tweet.
     */
    public function replyPrompt(string $tweet, ?string $threadContext, ?string $tone): string
    {
        $parts = [];

        if (filled($threadContext)) {
            $parts[] = "Conversation so far (oldest first):\n\"\"\"\n".trim($threadContext)."\n\"\"\"";
        }

        $parts[] = "The tweet to reply to:\n\"\"\"\n".trim($tweet)."\n\"\"\"";

        if (filled($tone) && $tone !== 'balanced') {
            $parts[] = 'Lean '.$tone.' in tone for these replies.';
        }

        $parts[] = 'If the tweet invites people to share, pitch, or drop a link to what they are building '
            .'(e.g. "pitch your startup", "drop your link", "what are you working on", "show me what you built"), '
            .'then reply by pitching the OWNER\'S OWN project in one or two natural lines and include the single '
            .'most relevant link from their profile. In that case promoting the link is the whole point — lead '
            .'with the project, keep the chosen tone, and do not give generic advice or a contrarian take instead. '
            .'If the profile lists more than one project/link, pick the one most relevant to the tweet.';

        $parts[] = 'Otherwise (a normal tweet), write short replies that add value or a sharp point of view and '
            .'invite engagement.';

        $parts[] = 'Every reply must be a standalone tweet under 280 characters, sound like the owner, not restate '
            .'the original tweet, and never start with "Great point" or similar filler.';

        return implode("\n\n", $parts);
    }

    /**
     * Prompt for generating original posts.
     */
    public function postPrompt(string $topic, string $format, ?string $tone): string
    {
        $parts = ["Topic / idea:\n\"\"\"\n".trim($topic)."\n\"\"\""];

        if (filled($tone) && $tone !== 'balanced') {
            $parts[] = 'Lean '.$tone.' in tone.';
        }

        $parts[] = match ($format) {
            'hook' => 'Write scroll-stopping opening lines (hooks) that make people want to read more. '
                .'One or two lines each, high curiosity, no clickbait lies.',
            'thread' => 'Write engaging X threads. Each option is a full thread: the first tweet is a strong hook, '
                .'then 3-6 follow-up tweets that each deliver one clear idea. Separate the tweets within a thread '
                .'with a blank line. Keep every tweet under 280 characters.',
            default => 'Write standalone posts (single tweets), each under 280 characters, each able to stand on its own '
                .'and earn likes/reposts. Where it fits the topic, reach for this high-engagement format: '
                .$this->engagementQuestionGuidance(),
        };

        return implode("\n\n", $parts);
    }

    /**
     * Prompt for generating a batch of standalone posts to fill a week's
     * schedule. No topic input — draws entirely from the voice profile
     * already threaded through the system prompt. Each slot is pinned to a
     * category (see POST_CATEGORIES) so the results can be tagged with a
     * legend, and so the week has guaranteed variety.
     *
     * @param  array<int, string>  $categories  One POST_CATEGORIES key per post, in order.
     * @param  array<int, string>  $recentPosts  Recently published/scheduled post content
     *                                           (most recent first) to steer the model away
     *                                           from repeating the same topics, angles, or
     *                                           sentence structures it already used.
     */
    public function weeklyBatchPrompt(array $categories, array $recentPosts = []): string
    {
        $total = count($categories);

        $list = collect($categories)
            ->values()
            ->map(fn (string $category, int $i) => ($i + 1).'. '.self::POST_CATEGORIES[$category].' — '.$this->categoryGuidance($category))
            ->implode("\n");

        $recentSection = '';

        if ($recentPosts !== []) {
            $recentList = collect($recentPosts)
                ->map(fn (string $post) => '- '.str_replace("\n", ' ', trim($post)))
                ->implode("\n");

            $recentSection = 'Posts already published or scheduled recently — do NOT repeat these topics, angles, '.
                'specific examples, or sentence structures. Each new post must explore genuinely new territory, '.
                "not a reworded version of one of these:\n\"\"\"\n{$recentList}\n\"\"\"\n\n";
        }

        return "Write {$total} standalone posts (single tweets) to fill out a week's posting schedule for the ".
            "account owner.\n\n".
            "{$recentSection}".
            "Write them in this exact order, one post per numbered style below:\n{$list}\n\n".
            'Each post must be under 280 characters, able to stand on its own, earn likes/replies/reposts, and '.
            "genuinely fit its assigned style — do not blend styles or repeat the same idea across posts.\n\n".
            'Vary the opening words, sentence structure, and format across every post in this batch — no two '.
            "posts should follow the same template, even within the same style.\n\n".
            'The style name (e.g. "Hot Take", "Tip / Value") is for your reference only, never for the reader — '.
            'do not begin a post with its style name or category as a label or prefix (e.g. never start a post '.
            'with "tip:", "hot take:", "question:", or similar).';
    }

    private function categoryGuidance(string $category): string
    {
        return match ($category) {
            'question' => $this->engagementQuestionGuidance(),
            'story' => 'Tell it in one of these variants, mixing across posts: (a) a short concrete scenario or '.
                'mini-story with a clear turn or lesson at the end; (b) a two-line before/after or then/now '.
                'contrast; (c) a dash-prefixed list of 3-4 short lessons tied to one specific theme.',
            'opinion' => 'Share a punchy, defensible contrarian point of view, in one of these variants: (a) a '.
                'single blunt declarative sentence; (b) a "most people think X, actually Y" contrast; (c) a short '.
                'list of 2-3 concrete examples backing one contrarian claim.',
            'tip' => 'Give one specific, actionable piece of advice, in one of these variants: (a) a single '.
                'imperative sentence; (b) a "do X instead of Y" contrast; (c) a 2-3 step micro-checklist.',
            'promo' => "Naturally mention what the owner is building or working on, using their profile's "
                .'projects/links when relevant — confident, not salesy.',
            'motivation' => 'Write a short motivational post for builders, in one of these variants: (a) a '.
                'two-line "If X, do A. / If Y, do B." contrast; (b) a calm reframe that kills a common anxiety '.
                '(being behind, comparing, starting late), one short line per idea; (c) an anaphora list of 4-8 '.
                'short lines that repeat the same opening word, closing with a blunt payoff line; (d) a blunt '.
                'two-sentence truth contrasting two kinds of people or two choices. Plain everyday words, calm '.
                'and confident, never hustle-bro energy, never generic "believe in yourself" filler.',
            'news' => 'Write a short, sharp post reacting to or sharing something notable from the news area the '.
                'owner specified in their profile (e.g. tech, a specific company like Figma or Claude/OpenAI shipping '.
                'an update, a broader development in that world). Use one of these variants, mixing across posts: '.
                '(a) a "Did you know that ..." interesting fact or tidbit; (b) a one-line take reacting to a notable '.
                'development; (c) a "X just did Y, here is why it matters" mini-observation. CRITICAL: only reference '.
                'facts, launches, or events you are actually confident are real and correct — never invent a product '.
                'launch, feature, date, number, or announcement. If you are not sure a specific recent event '.
                'happened, write about a well-established, evergreen fact in that area instead, or keep the take '.
                'general. Better a true evergreen fact than a fabricated breaking-news claim.',
            default => 'Write a standalone post that fits the owner\'s usual topics.',
        };
    }

    /**
     * Guidance for the high-engagement "direct address + blunt question" format:
     * a short address to a specific audience, a sharp question, then a
     * dash-prefixed list of blunt, specific answer options where the last one
     * lands as a self-aware or funny gut-punch. Mix in some as a single blunt
     * one-liner with no list at all.
     */
    private function engagementQuestionGuidance(): string
    {
        return "Use this high-engagement format, mixing both variants across posts:\n"
            ."(a) Address the audience directly on its own line (e.g. \"Founders,\" or the owner's own audience "
            .'from their profile), blank line, then a sharp, specific question, blank line, then 3-5 dash-prefixed '
            .'answer options. Each option is 1-4 words, concrete and specific to the topic (never generic filler '
            .'like "other" or "it depends"). The last option should land as a blunt, self-aware, or funny '
            ."admission that undercuts the polished ones before it.\n"
            .'(b) A single blunt, specific one-line question with no list — the kind that makes someone stop '
            .'scrolling because it calls out something they actually think but don\'t say out loud. '
            .'No generic questions like "what do you think?" — always tied to a real, specific situation.';
    }

    /** How closely a remixed post should track the original (see inspirationPrompt). */
    public const REMIX_CLOSENESS = [
        'build' => 'Build on original',
        'balanced' => 'Balanced',
        'mine' => 'Make it mine',
    ];

    /**
     * Prompt for the Inspiration "Remix this post" flow: take a viral post from
     * a tracked creator and rewrite it in the owner's own voice, staying as
     * close to (or far from) the original as $closeness asks.
     *
     * @param  string  $closeness  One of REMIX_CLOSENESS keys.
     */
    public function inspirationPrompt(string $originalPost, string $closeness = 'balanced', ?string $instructions = null): string
    {
        $parts = [
            "Here is a post from another creator that performed unusually well:\n\"\"\"\n"
                .trim($originalPost)."\n\"\"\"",
            $this->remixClosenessGuidance($closeness),
        ];

        if (filled($instructions)) {
            $parts[] = 'Additional instructions from the owner (follow these closely):'."\n".trim($instructions);
        }

        $parts[] = 'Write them in the owner\'s own voice, about the owner\'s own topics and experience. Do not '
            .'mention the original creator or that this is a remix. Each post must be under 280 characters, able '
            .'to stand on its own, and earn likes/replies/reposts.';

        return implode("\n\n", $parts);
    }

    private function remixClosenessGuidance(string $closeness): string
    {
        return match ($closeness) {
            'build' => 'Stay very close to the original: keep its exact structure, format, and rhythm, and reuse '
                .'most of its phrasing. Only lightly adapt the wording so it reads naturally in the owner\'s voice. '
                .'The result should be clearly recognizable as the same post, polished.',
            'mine' => 'Keep ONLY the underlying idea or insight of the original. Rewrite it completely from scratch '
                .'in the owner\'s own voice, structure, and examples. Do not reuse the original\'s wording, format, '
                .'or specific details — make it feel like the owner\'s own original post.',
            default => 'Keep the same overall shape and angle as the original (its hook, structure, and length), '
                .'but rewrite it in the owner\'s own words and voice. Match the format, not the exact wording.',
        };
    }

    /**
     * System prompt for the voice-analysis step.
     */
    public function analyzeSystemPrompt(): string
    {
        return 'You are an expert writing coach who analyzes a person\'s social-media voice so an AI can '
            .'reproduce it convincingly. Be specific and concrete, not generic.';
    }

    /**
     * Prompt that turns a set of the user's real posts into a reusable voice guide.
     *
     * @param  array<int, string>  $posts
     */
    public function analyzePrompt(array $posts): string
    {
        $joined = collect($posts)
            ->map(fn ($p) => '- '.trim($p))
            ->implode("\n");

        return "Here are real posts written by one X (Twitter) user:\n\"\"\"\n".$joined."\n\"\"\"\n\n"
            .'Write a concise voice guide (120-180 words) another writer could follow to sound exactly like them. '
            .'Cover: overall tone and personality; sentence length and rhythm; capitalization and punctuation habits '
            .'(e.g. lowercase, no periods); emoji and hashtag usage; recurring words, phrases, or structures; and what '
            .'they clearly avoid. Write it as direct instructions ("Write in lowercase...", "Keep sentences short..."). '
            .'Output only the guide, no preamble.';
    }

    private function toneGuidance(string $tone): string
    {
        return match ($tone) {
            'witty' => 'Be clever and playful; land a light joke or unexpected angle without trying too hard.',
            'professional' => 'Be credible, clear, and useful; authoritative but not stiff.',
            'contrarian' => 'Challenge the common take with a defensible, non-obvious argument. Never rude for its own sake.',
            'hype' => 'Be energetic and motivating; short punchy lines that build momentum.',
            'friendly' => 'Be warm, approachable, and conversational.',
            'funny' => 'Be genuinely funny: crack a joke, use absurd exaggeration, an unexpected punchline, or self-aware humor. Aim to make the reader laugh while still being relevant. Never corny, forced, or using hashtag-jokes — land it like a person with good comedic timing, not a brand account.',
            default => 'Be natural and confident; useful and human.',
        };
    }
}
