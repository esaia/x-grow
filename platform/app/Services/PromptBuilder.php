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
            '- No corporate buzzwords, no "As an AI", no disclaimers, no em-dashes unless the samples use them.',
            '- Prefer concrete, specific, opinionated writing over generic platitudes.',
        ];

        $tone = $profile?->tone ?: 'balanced';
        $lines[] = '';
        $lines[] = 'Default tone: '.$tone.'. '.$this->toneGuidance($tone);

        if ($profile) {
            if (filled($profile->bio_context)) {
                $lines[] = '';
                $lines[] = "About the account owner (use for relevance):\n".trim($profile->bio_context);
            }

            if (filled($profile->topics)) {
                $lines[] = '';
                $lines[] = "Main topics the owner posts about:\n".trim($profile->topics);
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
                .'and earn likes/reposts.',
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
     */
    public function weeklyBatchPrompt(array $categories): string
    {
        $total = count($categories);

        $list = collect($categories)
            ->values()
            ->map(fn (string $category, int $i) => ($i + 1).'. '.self::POST_CATEGORIES[$category].' — '.$this->categoryGuidance($category))
            ->implode("\n");

        return "Write {$total} standalone posts (single tweets) to fill out a week's posting schedule for the ".
            "account owner.\n\n".
            "Write them in this exact order, one post per numbered style below:\n{$list}\n\n".
            'Each post must be under 280 characters, able to stand on its own, earn likes/replies/reposts, and '.
            'genuinely fit its assigned style — do not blend styles or repeat the same idea across posts.';
    }

    private function categoryGuidance(string $category): string
    {
        return match ($category) {
            'question' => 'Ask a genuine question or run a mini poll that invites replies.',
            'story' => 'Tell a short, concrete story or lesson from real experience.',
            'opinion' => 'Share a punchy, defensible hot take or contrarian opinion.',
            'tip' => 'Give one specific, actionable tip the reader can use today.',
            'promo' => "Naturally mention what the owner is building or working on, using their profile's "
                .'projects/links when relevant — confident, not salesy.',
            default => 'Write a standalone post that fits the owner\'s usual topics.',
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
