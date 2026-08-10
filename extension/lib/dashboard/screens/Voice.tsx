import { useEffect, useState } from 'react';
import { TONES } from '@/lib/ai/prompts';
import { bg } from '@/lib/messaging';
import type { VoiceProfile, XAccount } from '@/lib/types';
import { Banner, Button, Card, ChipGroup, Spinner, TextArea } from '@/lib/dashboard/ui';

/** User-facing explanation + example for each tone. Ported from voice.tsx. */
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
    description:
      'Challenges the common take with a defensible, non-obvious point.',
    example: 'Everyone says "niche down." That advice is mostly wrong.',
  },
  hype: {
    description:
      'Energetic and motivating. Short punchy lines that build momentum.',
    example: 'This is the year. Build the thing. Ship it today.',
  },
  friendly: {
    description: 'Warm, approachable, and conversational.',
    example: 'honestly, so happy for you — this is huge.',
  },
  funny: {
    description:
      'Genuinely funny. Jokes, absurd exaggeration, and unexpected punchlines — never corny.',
    example: 'my business plan is just vibes and a Stripe account.',
  },
};

type TextField = keyof Pick<
  VoiceProfile,
  | 'sample_posts'
  | 'bio_context'
  | 'facts'
  | 'topics'
  | 'news_context'
  | 'audience'
  | 'projects'
  | 'links'
  | 'dos'
  | 'donts'
>;

const FIELDS: {
  key: TextField;
  title: string;
  description: string;
  placeholder: string;
  rows?: number;
}[] = [
  {
    key: 'sample_posts',
    title: 'Your best posts',
    description:
      'Paste a handful of your real tweets (one per line). This is the single biggest factor in sounding like you.',
    placeholder:
      'shipping > planning. build the thing.\nmost advice is just survivorship bias in a nice font.',
    rows: 8,
  },
  {
    key: 'bio_context',
    title: 'About you',
    description:
      'Who you are and what your account is about — used to keep replies relevant.',
    placeholder:
      'Indie hacker building AI tools. I post about shipping fast, design, and the reality of running a solo SaaS.',
  },
  {
    key: 'facts',
    title: 'Facts (only true things)',
    description:
      "Real, specific facts the AI is allowed to state — dates, timelines, metrics, stack. This stops it from guessing numbers like \"6 months\" out of thin air. If it's not listed here, the AI writes around it instead of inventing it.",
    placeholder:
      'Product: X-Grow, an AI copilot for growing on X.\nStarted building: March 2026.\nStack: Chrome extension, React, OpenAI API.\nReal metrics: 40 beta users, no revenue yet.',
    rows: 5,
  },
  {
    key: 'topics',
    title: 'Topics you post about',
    description:
      'Your niche and recurring themes — helps the AI stay on-brand and suggest relevant posts.',
    placeholder: 'building in public, indie hacking, AI tools, web dev, design',
  },
  {
    key: 'news_context',
    title: 'News for "News" posts',
    description:
      "What kind of news you want your \"News\" scheduled posts to cover — the area, companies, or angle. Used only for the News category. The AI sticks to facts it's confident are real and won't invent breaking news.",
    placeholder:
      'Tech news — companies like Figma, Claude/OpenAI, Vercel dropping updates.\n"Did you know that..." style facts about the tech world.',
  },
  {
    key: 'audience',
    title: 'Who you want to reach',
    description:
      "The audience you're trying to grow — the AI tailors replies and posts toward them.",
    placeholder:
      'other founders, developers, and people who might use my product',
  },
  {
    key: 'projects',
    title: "What you're building",
    description:
      'Your current projects/products. The AI can bring these up naturally when relevant.',
    placeholder:
      'X-Grow — an AI copilot for growing on X.\nA second side project about ...',
  },
  {
    key: 'links',
    title: 'Your links',
    description:
      "Websites, products, or profiles (one per line). The AI only shares a link when it's genuinely relevant — never as spam.",
    placeholder:
      'https://mysite.com — my main site\nhttps://myproduct.com — the product I sell',
  },
  {
    key: 'dos',
    title: 'Always',
    description: 'Rules the AI must follow.',
    placeholder: 'Keep it lowercase. Be concrete. End with a question sometimes.',
    rows: 3,
  },
  {
    key: 'donts',
    title: 'Never',
    description: 'Things the AI must avoid.',
    placeholder: "No hashtags. No emojis. No 'Great point!'. No corporate buzzwords.",
    rows: 3,
  },
];

export default function Voice({ account }: { account: XAccount }) {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [learning, setLearning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void bg.getVoice().then((res) => {
      if (res.ok) setProfile(res.data);
      else setError(res.error);
    });
  }, []);

  if (!profile) {
    return (
      <div className="flex items-center gap-3 text-fg-muted">
        <Spinner /> Loading your voice profile…
      </div>
    );
  }

  const set = <K extends keyof VoiceProfile>(key: K, value: VoiceProfile[K]) => {
    setProfile({ ...profile, [key]: value });
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError('');

    const res = await bg.saveVoice(profile);

    setSaving(false);

    if (res.ok) {
      setProfile(res.data);
      setDirty(false);
      setSaved(true);
    } else {
      setError(res.error);
    }
  };

  /**
   * Learn from the connected account's real posts. The background opens a small
   * visible window on the profile and scrolls it — X won't load a timeline it
   * believes is off screen, which is the same constraint harvesting has.
   */
  const learn = async () => {
    setLearning(true);
    setError('');
    setNotice('');

    const res = await bg.learnFromProfile();

    if (res.ok) {
      const fresh = await bg.getVoice();
      if (fresh.ok) setProfile(fresh.data);
      setNotice(`Learned your voice from ${res.data.count} posts.`);
    } else {
      setError(res.error);
    }

    setLearning(false);
  };

  const tone = TONE_META[profile.tone] ?? TONE_META.balanced;

  return (
    <div className="flex flex-col gap-5 pb-24">
      <header>
        <h1 className="text-xl font-bold">Voice profile</h1>
        <p className="mt-1 max-w-prose text-sm text-fg-muted">
          Everything here is folded into the system prompt behind every reply and
          post. The more concrete it is, the less the output sounds like AI.
        </p>
      </header>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <Card
        title={profile.voice_analysis ? 'Learned voice' : 'Learn your voice'}
        description={
          profile.voice_analysis
            ? `Analyzed from @${profile.x_handle ?? account.handle}'s real posts. Re-run it after your style shifts.`
            : `Read @${account.handle}'s recent posts and turn them into a voice guide the AI follows. A small window opens while it reads — X only loads a timeline it can see.`
        }
        actions={
          <Button variant="ghost" onClick={learn} disabled={learning}>
            {learning ? <Spinner /> : null}
            {learning ? 'Reading…' : profile.voice_analysis ? 'Re-learn' : 'Learn my voice'}
          </Button>
        }
      >
        {profile.voice_analysis ? (
          <p className="text-base leading-relaxed whitespace-pre-wrap text-fg-muted">
            {profile.voice_analysis}
          </p>
        ) : (
          <p className="text-sm text-fg-faint">
            Nothing learned yet. This is the fastest way to make replies sound
            like you.
          </p>
        )}
      </Card>

      <Card
        title="Default tone"
        description="Used whenever you don't pick a different one in the composer."
      >
        <ChipGroup
          values={TONES}
          value={profile.tone}
          onChange={(next) => set('tone', next)}
        />
        <div className="mt-4 rounded-lg border border-line bg-ink-900 p-3">
          <p className="text-sm text-fg-muted">{tone.description}</p>
          <p className="mt-2 text-base text-fg italic">“{tone.example}”</p>
        </div>
      </Card>

      {FIELDS.map((field) => (
        <Card key={field.key} title={field.title} description={field.description}>
          <TextArea
            rows={field.rows ?? 4}
            value={profile[field.key] ?? ''}
            placeholder={field.placeholder}
            onChange={(e) => set(field.key, e.target.value || null)}
          />
        </Card>
      ))}

      {/* Pinned so the save button is reachable from anywhere in a long form. */}
      <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-line bg-ink-900/95 px-1 py-3 backdrop-blur">
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? <Spinner /> : null}
          {saving ? 'Saving…' : 'Save voice profile'}
        </Button>
        {saved && <span className="text-sm text-ok">Saved.</span>}
        {dirty && !saving && (
          <span className="text-sm text-fg-muted">Unsaved changes.</span>
        )}
      </div>
    </div>
  );
}
