import { Head, useForm } from '@inertiajs/react';
import { Check } from 'lucide-react';
import Heading from '@/components/heading';
import InputError from '@/components/input-error';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// User-facing explanation + example for each tone the backend supports.
const TONE_META: Record<string, { description: string; example: string }> = {
    balanced: {
        description: 'Natural and confident. Useful and human — a safe default.',
        example: "Here's what actually moved the needle for me.",
    },
    witty: {
        description: 'Clever and playful. Lands a light joke or a surprising angle.',
        example: 'I tried the 5am club. My bed filed a complaint.',
    },
    professional: {
        description: 'Credible, clear, and useful. Authoritative but not stiff.',
        example: 'Three lessons from shipping to my first 10k users.',
    },
    contrarian: {
        description: 'Challenges the common take with a defensible, non-obvious point.',
        example: 'Everyone says "niche down." That advice is mostly wrong.',
    },
    hype: {
        description: 'Energetic and motivating. Short punchy lines that build momentum.',
        example: 'This is the year. Build the thing. Ship it today.',
    },
    friendly: {
        description: 'Warm, approachable, and conversational.',
        example: 'honestly, so happy for you — this is huge.',
    },
    funny: {
        description: 'Genuinely funny. Jokes, absurd exaggeration, and unexpected punchlines — never corny.',
        example: 'my business plan is just vibes and a Stripe account.',
    },
};

type VoiceProfile = {
    tone: string;
    sample_posts: string | null;
    bio_context: string | null;
    facts: string | null;
    links: string | null;
    projects: string | null;
    topics: string | null;
    audience: string | null;
    dos: string | null;
    donts: string | null;
};

type Learned = {
    x_handle: string | null;
    voice_analysis: string | null;
    learned_at: string | null;
};

export default function Voice({
    profile,
    learned,
    tones,
}: {
    profile: VoiceProfile;
    learned: Learned;
    tones: string[];
}) {
    const form = useForm({
        tone: profile.tone ?? 'balanced',
        bio_context: profile.bio_context ?? '',
        facts: profile.facts ?? '',
        sample_posts: profile.sample_posts ?? '',
        links: profile.links ?? '',
        projects: profile.projects ?? '',
        topics: profile.topics ?? '',
        audience: profile.audience ?? '',
        dos: profile.dos ?? '',
        donts: profile.donts ?? '',
    });

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        form.put('/voice', { preserveScroll: true });
    };

    return (
        <>
            <Head title="Voice profile" />

            <div className="flex h-full flex-1 flex-col gap-6 p-4">
                <Heading
                    title="Voice profile"
                    description="Teach the AI to sound like you. The more real examples you give, the better your replies and posts will feel."
                />

                <Card className="w-full max-w-3xl border-primary/30 bg-primary/5">
                    <CardHeader>
                        <CardTitle>Learned from your X posts</CardTitle>
                        <CardDescription>
                            {learned.voice_analysis
                                ? `Analyzed from ${learned.x_handle ? '@' + learned.x_handle : 'your profile'}${learned.learned_at ? ' · ' + learned.learned_at : ''}. This drives your voice automatically.`
                                : 'Not learned yet. On x.com, open your own profile and click “✨ Learn my voice” — the AI will study your posts and write like you.'}
                        </CardDescription>
                    </CardHeader>
                    {learned.voice_analysis && (
                        <CardContent>
                            <p className="whitespace-pre-wrap rounded-lg border border-border bg-background/50 p-3 text-sm text-muted-foreground">
                                {learned.voice_analysis}
                            </p>
                        </CardContent>
                    )}
                </Card>

                <form
                    onSubmit={submit}
                    className="grid w-full max-w-3xl grid-cols-1 gap-6"
                >
                    <Card>
                        <CardHeader>
                            <CardTitle>Default tone</CardTitle>
                            <CardDescription>
                                The overall attitude the AI leans into. You can
                                still override this per generation.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div
                                role="radiogroup"
                                aria-label="Default tone"
                                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                            >
                                {tones.map((t) => {
                                    const meta = TONE_META[t];
                                    const selected = form.data.tone === t;
                                    return (
                                        <button
                                            type="button"
                                            key={t}
                                            role="radio"
                                            aria-checked={selected}
                                            onClick={() =>
                                                form.setData('tone', t)
                                            }
                                            className={cn(
                                                'rounded-xl border p-3 text-left transition outline-none',
                                                selected
                                                    ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                                                    : 'border-border hover:border-primary/50',
                                            )}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="font-semibold capitalize">
                                                    {t}
                                                </span>
                                                {selected && (
                                                    <Check className="size-4 shrink-0 text-primary" />
                                                )}
                                            </div>
                                            {meta && (
                                                <>
                                                    <p className="mt-1 text-sm text-muted-foreground">
                                                        {meta.description}
                                                    </p>
                                                    <p className="mt-2 text-xs text-muted-foreground/70 italic">
                                                        e.g. “{meta.example}”
                                                    </p>
                                                </>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            <InputError
                                className="mt-2"
                                message={form.errors.tone}
                            />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Your best posts</CardTitle>
                            <CardDescription>
                                Paste a handful of your real tweets (one per
                                line). This is the single biggest factor in
                                sounding like you.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Label htmlFor="sample_posts" className="sr-only">
                                Sample posts
                            </Label>
                            <Textarea
                                id="sample_posts"
                                className="min-h-40"
                                value={form.data.sample_posts}
                                onChange={(e) =>
                                    form.setData('sample_posts', e.target.value)
                                }
                                placeholder={
                                    'shipping > planning. build the thing.\nmost advice is just survivorship bias in a nice font.'
                                }
                            />
                            <InputError message={form.errors.sample_posts} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>About you</CardTitle>
                            <CardDescription>
                                Who you are and what your account is about — used
                                to keep replies relevant.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Textarea
                                id="bio_context"
                                value={form.data.bio_context}
                                onChange={(e) =>
                                    form.setData('bio_context', e.target.value)
                                }
                                placeholder="Indie hacker building AI tools. I post about shipping fast, design, and the reality of running a solo SaaS."
                            />
                            <InputError message={form.errors.bio_context} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Facts (only true things)</CardTitle>
                            <CardDescription>
                                Real, specific facts the AI is allowed to
                                state — dates, timelines, metrics, stack. This
                                stops it from guessing numbers like "6 months"
                                out of thin air. If it's not listed here, the
                                AI should write around it instead of inventing
                                it.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Textarea
                                id="facts"
                                value={form.data.facts}
                                onChange={(e) =>
                                    form.setData('facts', e.target.value)
                                }
                                placeholder={
                                    'Product: X-Grow, an AI copilot for growing on X.\nStarted building: March 2026.\nStack: Laravel, React, MySQL, Claude API.\nReal metrics: 40 beta users, no revenue yet.'
                                }
                            />
                            <InputError message={form.errors.facts} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Topics you post about</CardTitle>
                            <CardDescription>
                                Your niche and recurring themes — helps the AI
                                stay on-brand and suggest relevant posts.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Textarea
                                id="topics"
                                value={form.data.topics}
                                onChange={(e) =>
                                    form.setData('topics', e.target.value)
                                }
                                placeholder="building in public, indie hacking, AI tools, web dev, design"
                            />
                            <InputError message={form.errors.topics} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Who you want to reach</CardTitle>
                            <CardDescription>
                                The audience you're trying to grow — the AI tailors
                                replies and posts toward them.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Textarea
                                id="audience"
                                value={form.data.audience}
                                onChange={(e) =>
                                    form.setData('audience', e.target.value)
                                }
                                placeholder="other founders, developers, and people who might use my product"
                            />
                            <InputError message={form.errors.audience} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>What you're building</CardTitle>
                            <CardDescription>
                                Your current projects/products. The AI can bring
                                these up naturally when relevant.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Textarea
                                id="projects"
                                value={form.data.projects}
                                onChange={(e) =>
                                    form.setData('projects', e.target.value)
                                }
                                placeholder={
                                    'X-Grow — an AI copilot for growing on X.\nA second side project about ...'
                                }
                            />
                            <InputError message={form.errors.projects} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Your links</CardTitle>
                            <CardDescription>
                                Websites, products, or profiles (one per line). The
                                AI only shares a link when it's genuinely relevant —
                                never as spam.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-2">
                            <Textarea
                                id="links"
                                value={form.data.links}
                                onChange={(e) =>
                                    form.setData('links', e.target.value)
                                }
                                placeholder={
                                    'https://mysite.com — my main site\nhttps://myproduct.com — the product I sell'
                                }
                            />
                            <InputError message={form.errors.links} />
                        </CardContent>
                    </Card>

                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                        <Card>
                            <CardHeader>
                                <CardTitle>Always</CardTitle>
                                <CardDescription>
                                    Rules the AI must follow.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid grid-cols-1 gap-2">
                                <Textarea
                                    id="dos"
                                    value={form.data.dos}
                                    onChange={(e) =>
                                        form.setData('dos', e.target.value)
                                    }
                                    placeholder="Keep it lowercase. Be concrete. End with a question sometimes."
                                />
                                <InputError message={form.errors.dos} />
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Never</CardTitle>
                                <CardDescription>
                                    Things the AI must avoid.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid grid-cols-1 gap-2">
                                <Textarea
                                    id="donts"
                                    value={form.data.donts}
                                    onChange={(e) =>
                                        form.setData('donts', e.target.value)
                                    }
                                    placeholder="No hashtags. No emojis. No 'Great point!'. No corporate buzzwords."
                                />
                                <InputError message={form.errors.donts} />
                            </CardContent>
                        </Card>
                    </div>

                    <div className="flex items-center gap-3">
                        <Button disabled={form.processing}>
                            Save voice profile
                        </Button>
                        {form.recentlySuccessful && (
                            <span className="text-sm text-muted-foreground">
                                Saved.
                            </span>
                        )}
                    </div>
                </form>
            </div>
        </>
    );
}

Voice.layout = {
    breadcrumbs: [{ title: 'Voice profile', href: '/voice' }],
};
