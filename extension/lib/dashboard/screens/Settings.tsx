import { useRef, useState } from 'react';
import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from '@/lib/config';
import type { Backup } from '@/lib/db';
import { bg } from '@/lib/messaging';
import type { SettingsState } from '@/lib/types';
import {
  Banner,
  Button,
  Card,
  Field,
  Spinner,
  TextInput,
} from '@/lib/dashboard/ui';

export default function Settings({
  settings,
  onChange,
}: {
  settings: SettingsState;
  onChange: (next: SettingsState) => void;
}) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [busy, setBusy] = useState<'test' | 'save' | 'import' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const test = async () => {
    setBusy('test');
    setError('');
    setNotice('');

    // Test what's typed, before it's stored, so a bad key never lands.
    const res = await bg.testKey({
      apiKey: key.trim() || undefined,
      model: model.trim(),
      baseUrl: baseUrl.trim(),
    });

    setBusy(null);

    if (res.ok) setNotice(`Works. Responded as ${res.data.model}.`);
    else setError(res.error);
  };

  const save = async () => {
    setBusy('save');
    setError('');
    setNotice('');

    const res = await bg.saveSettings({
      // An untouched key field means "leave the stored key alone".
      apiKey: key.trim() === '' ? undefined : key.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
    });

    setBusy(null);

    if (res.ok) {
      onChange(res.data);
      setKey('');
      setModel(res.data.model);
      setBaseUrl(res.data.baseUrl);
      setNotice('Settings saved.');
    } else {
      setError(res.error);
    }
  };

  const disconnect = async () => {
    const res = await bg.disconnectAccount();
    if (res.ok) onChange(res.data);
  };

  const removeKey = async () => {
    const res = await bg.saveSettings({ apiKey: '' });
    if (res.ok) {
      onChange(res.data);
      setNotice('API key removed.');
    }
  };

  const exportData = async () => {
    const res = await bg.exportData();

    if (!res.ok) {
      setError(res.error);
      return;
    }

    const blob = new Blob([JSON.stringify(res.data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `x-grow-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();

    URL.revokeObjectURL(url);
  };

  const importData = async (file: File) => {
    setBusy('import');
    setError('');
    setNotice('');

    try {
      const backup = JSON.parse(await file.text()) as Backup;

      if (!backup || typeof backup !== 'object' || !('voiceProfile' in backup)) {
        throw new Error("That file doesn't look like an X-Grow backup.");
      }

      const res = await bg.importData(backup);

      if (!res.ok) throw new Error(res.error);

      const fresh = await bg.getSettings();
      if (fresh.ok) onChange(fresh.data);

      setNotice('Backup restored.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5 pb-12">
      <header>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="mt-1 max-w-prose text-sm text-fg-muted">
          X-Grow runs entirely in this browser. Your key, your voice profile and
          your schedule never leave it.
        </p>
      </header>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {settings.account && (
        <Card
          title="X account"
          description="Everything X-Grow writes, and every post it schedules, is for this account."
          actions={
            <Button variant="danger" onClick={disconnect}>
              Disconnect
            </Button>
          }
        >
          <div className="flex items-center gap-3">
            {settings.account.avatar_url ? (
              <img
                src={settings.account.avatar_url}
                alt=""
                className="size-11 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="size-11 shrink-0 rounded-full bg-ink-700" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-base font-bold">
                {settings.account.name ?? settings.account.handle}
              </span>
              <span className="block text-sm text-fg-muted">
                @{settings.account.handle}
              </span>
            </span>
          </div>
        </Card>
      )}

      <Card
        title="OpenAI"
        description="Generation is billed to your own OpenAI account. The key is stored in this browser's extension storage and is only ever read by the background worker."
      >
        <div className="flex flex-col gap-4">
          <Field
            label="API key"
            hint={
              settings.hasKey
                ? 'A key is saved. Leave this blank to keep it, or paste a new one to replace it.'
                : 'Create one at platform.openai.com → API keys.'
            }
          >
            <TextInput
              type="password"
              value={key}
              placeholder={settings.hasKey ? '•••••••••••••••••' : 'sk-…'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" hint={`Default: ${DEFAULT_OPENAI_MODEL}`}>
              <TextInput
                value={model}
                spellCheck={false}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>

            <Field
              label="Base URL"
              hint="Only change this for a proxy or an OpenAI-compatible provider — its host also has to be added to the extension's host permissions."
            >
              <TextInput
                value={baseUrl}
                placeholder={DEFAULT_OPENAI_BASE_URL}
                spellCheck={false}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} disabled={busy !== null}>
              {busy === 'save' ? <Spinner /> : null}
              Save
            </Button>
            <Button variant="ghost" onClick={test} disabled={busy !== null}>
              {busy === 'test' ? <Spinner /> : null}
              Test connection
            </Button>
            {settings.hasKey && (
              <Button variant="danger" onClick={removeKey} disabled={busy !== null}>
                Remove key
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="Backup"
        description="There is no server and no sync, so this file is your only copy. Export it somewhere safe before you reinstall Chrome or move machines."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={exportData}>
            Export everything
          </Button>
          <Button
            variant="ghost"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
          >
            {busy === 'import' ? <Spinner /> : null}
            Import a backup
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importData(file);
            }}
          />
        </div>
        <p className="mt-3 text-sm text-fg-faint">
          Importing replaces everything currently stored.
        </p>
      </Card>
    </div>
  );
}
