import { useState } from 'react';
import { POST_FORMATS, TONES } from '@/lib/ai/prompts';
import { MAX_TWEET } from '@/lib/config';
import { bg } from '@/lib/messaging';
import type { PostFormat } from '@/lib/ai/prompts';
import type { SettingsState } from '@/lib/types';
import {
  Banner,
  Button,
  Card,
  ChipGroup,
  EmptyState,
  Field,
  Spinner,
  TextArea,
} from '@/lib/dashboard/ui';

/** Fields that most move the needle on output quality, for the checklist. */
const KEY_FIELDS = [
  { key: 'sample_posts', label: 'Sample posts' },
  { key: 'bio_context', label: 'About you' },
  { key: 'facts', label: 'Facts' },
  { key: 'topics', label: 'Topics' },
  { key: 'audience', label: 'Audience' },
] as const;

export default function Home({
  settings,
  onGoTo,
}: {
  settings: SettingsState;
  onGoTo: (screen: 'voice' | 'settings') => void;
}) {
  const [topic, setTopic] = useState('');
  const [format, setFormat] = useState<PostFormat>('single');
  const [tone, setTone] = useState(settings.voiceProfile?.tone ?? 'balanced');
  const [options, setOptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<number | null>(null);

  const profile = settings.voiceProfile;
  const filled = KEY_FIELDS.filter((field) => {
    const value = profile?.[field.key];
    return typeof value === 'string' && value.trim() !== '';
  });

  const generate = async () => {
    if (topic.trim() === '') return;

    setBusy(true);
    setError('');
    setOptions([]);

    const res = await bg.post({ topic: topic.trim(), format, tone, count: 3 });

    setBusy(false);

    if (res.ok) setOptions(res.data.options);
    else setError(res.error);
  };

  const copy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopied(index);
    setTimeout(() => setCopied(null), 1600);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5 pb-12">
      <header>
        <h1 className="text-xl font-bold">Home</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {settings.usage.today} generated today · {settings.usage.total} all
          time.
        </p>
      </header>

      {!settings.hasKey && (
        <Banner tone="error">
          No OpenAI API key set — nothing will generate until you add one in
          Settings.
        </Banner>
      )}

      <Card
        title="Voice profile"
        description="How complete your profile is. Every empty field is context the model has to guess at."
        actions={
          <Button variant="ghost" onClick={() => onGoTo('voice')}>
            Edit
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2">
          {KEY_FIELDS.map((field) => {
            const done = filled.some((f) => f.key === field.key);

            return (
              <span
                key={field.key}
                className={
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-sm ' +
                  (done
                    ? 'border-ok/40 bg-ok/10 text-ok'
                    : 'border-line-strong text-fg-faint')
                }
              >
                {done ? '✓' : '○'} {field.label}
              </span>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-fg-muted">
          {filled.length} of {KEY_FIELDS.length} filled
          {profile?.voice_analysis ? ' · learned voice on file' : ''}.
        </p>
      </Card>

      <Card
        title="Quick post"
        description="Drafts only. Nothing is published from here."
      >
        <div className="flex flex-col gap-4">
          <Field label="Topic">
            <TextArea
              rows={3}
              value={topic}
              placeholder="What's this post about? A topic, a link, or a rough idea."
              onChange={(e) => setTopic(e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format">
              <ChipGroup
                values={POST_FORMATS}
                value={format}
                onChange={(next) => setFormat(next as PostFormat)}
              />
            </Field>
            <Field label="Tone">
              <ChipGroup values={TONES} value={tone} onChange={setTone} />
            </Field>
          </div>

          <div>
            <Button onClick={generate} disabled={busy || topic.trim() === ''}>
              {busy ? <Spinner /> : null}
              {busy ? 'Writing…' : 'Write 3 posts'}
            </Button>
          </div>

          {error && <Banner tone="error">{error}</Banner>}

          {options.length > 0 && (
            <div className="flex flex-col gap-2">
              {options.map((option, index) => (
                <article
                  key={index}
                  className="xg-anim-rise rounded-lg border border-line bg-ink-900 p-4"
                >
                  <p className="text-base leading-relaxed whitespace-pre-wrap">
                    {option}
                  </p>
                  <footer className="mt-3 flex items-center justify-between">
                    <span
                      className={
                        'text-sm ' +
                        (option.length > MAX_TWEET ? 'text-danger' : 'text-fg-faint')
                      }
                    >
                      {option.length} / {MAX_TWEET}
                    </span>
                    <Button variant="ghost" onClick={() => copy(option, index)}>
                      {copied === index ? 'Copied' : 'Copy'}
                    </Button>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </div>
      </Card>

      {!settings.hasKey && (
        <EmptyState title="Add your OpenAI key to start">
          <Button variant="ghost" onClick={() => onGoTo('settings')}>
            Open settings
          </Button>
        </EmptyState>
      )}
    </div>
  );
}
