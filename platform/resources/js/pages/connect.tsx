import { Head, router, useForm, usePage } from '@inertiajs/react';
import { useState } from 'react';
import Heading from '@/components/heading';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type Token = {
    id: number;
    name: string;
    last_used_at: string | null;
    created_at: string | null;
};

// A connected posting destination: an X account, a LinkedIn member, or a
// LinkedIn company page (kind = organization).
type SocialAccount = {
    id: number;
    provider: string;
    kind: string;
    label: string;
    is_active: boolean;
    expires_at: string | null;
};

const PROVIDER_LABELS: Record<string, string> = {
    x: 'X',
    linkedin: 'LinkedIn',
};

export default function Connect({
    tokens,
    apiBaseUrl,
    newToken,
    accounts,
    linkedinPagesEnabled,
}: {
    tokens: Token[];
    apiBaseUrl: string;
    newToken: string | null;
    accounts: SocialAccount[];
    linkedinPagesEnabled: boolean;
}) {
    const { errors } = usePage().props as {
        errors?: { x?: string; linkedin?: string };
    };
    const form = useForm({ name: 'Chrome extension' });
    const [copied, setCopied] = useState<string | null>(null);

    const generate = (e: React.FormEvent) => {
        e.preventDefault();
        form.post('/connect/token', { preserveScroll: true });
    };

    const revoke = (id: number) => {
        router.delete(`/connect/token/${id}`, { preserveScroll: true });
    };

    const copy = (text: string, key: string) => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(key);
            setTimeout(() => setCopied(null), 1500);
        });
    };

    const disconnect = (id: number) => {
        router.delete(`/connect/accounts/${id}`, { preserveScroll: true });
    };

    // Pausing keeps the connection and its scheduled posts — they just stop
    // publishing until it's switched back on.
    const setActive = (id: number, isActive: boolean) => {
        router.put(
            `/connect/accounts/${id}`,
            { is_active: isActive },
            { preserveScroll: true },
        );
    };

    const byProvider = (provider: string) =>
        accounts.filter((account) => account.provider === provider);

    return (
        <>
            <Head title="Connect extension" />

            <div className="flex h-full flex-1 flex-col gap-6 p-4">
                <Heading
                    title="Connect the Chrome extension"
                    description="Generate a token, then paste it into the X-Grow extension popup to link it to your account."
                />

                <div className="grid w-full max-w-3xl grid-cols-1 gap-6">
                    {newToken && (
                        <Card className="border-green-500/40">
                            <CardHeader>
                                <CardTitle>Your new token</CardTitle>
                                <CardDescription>
                                    Copy it now — for security it won't be shown
                                    again. Paste it into the extension popup.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
                                <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-sm">
                                    {newToken}
                                </code>
                                <Button
                                    type="button"
                                    onClick={() => copy(newToken, 'new')}
                                >
                                    {copied === 'new' ? 'Copied!' : 'Copy'}
                                </Button>
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader>
                            <CardTitle>Posting accounts</CardTitle>
                            <CardDescription>
                                Every account you connect becomes a target you
                                can schedule posts to. Switch one off to pause
                                it — it keeps its connection and its posts, but
                                stops publishing until you switch it back on.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                            {(errors?.x || errors?.linkedin) && (
                                <p className="text-sm text-destructive">
                                    {errors.x ?? errors.linkedin}
                                </p>
                            )}

                            {accounts.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    No accounts connected yet. Until you connect
                                    one, posts you approve stay Scheduled and
                                    won't go out on their own.
                                </p>
                            ) : (
                                <ul className="divide-y divide-border">
                                    {accounts.map((account) => (
                                        <li
                                            key={account.id}
                                            className="flex items-center justify-between gap-4 py-3"
                                        >
                                            <div
                                                className={cn(
                                                    'min-w-0',
                                                    !account.is_active &&
                                                        'opacity-50',
                                                )}
                                            >
                                                <p className="truncate font-medium">
                                                    {account.label}
                                                    {account.kind ===
                                                        'organization' && (
                                                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                                                            Company page
                                                        </span>
                                                    )}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {PROVIDER_LABELS[
                                                        account.provider
                                                    ] ?? account.provider}
                                                    {account.expires_at
                                                        ? ` · access expires ${account.expires_at}`
                                                        : ''}
                                                    {!account.is_active &&
                                                        ' · paused'}
                                                </p>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-3">
                                                <Switch
                                                    checked={account.is_active}
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
                                                        setActive(
                                                            account.id,
                                                            checked,
                                                        )
                                                    }
                                                    aria-label={`${account.is_active ? 'Pause' : 'Resume'} ${account.label}`}
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() =>
                                                        disconnect(account.id)
                                                    }
                                                >
                                                    Disconnect
                                                </Button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="flex flex-wrap gap-2">
                                <Button asChild variant="outline">
                                    <a href="/connect/x/redirect">
                                        {byProvider('x').length > 0
                                            ? 'Connect another X account'
                                            : 'Connect X account'}
                                    </a>
                                </Button>
                                <Button asChild variant="outline">
                                    <a href="/connect/linkedin/redirect">
                                        {byProvider('linkedin').length > 0
                                            ? 'Connect another LinkedIn account'
                                            : 'Connect LinkedIn account'}
                                    </a>
                                </Button>
                                {linkedinPagesEnabled && (
                                    <Button asChild variant="outline">
                                        <a href="/connect/linkedin/pages/redirect">
                                            Connect LinkedIn pages
                                        </a>
                                    </Button>
                                )}
                            </div>

                            <p className="text-xs text-muted-foreground">
                                {linkedinPagesEnabled
                                    ? '“Connect LinkedIn pages” adds every company page you administer as its own target.'
                                    : 'LinkedIn company pages need a second LinkedIn app whose only product is the Community Management API — LinkedIn refuses to grant it alongside the sign-in products. Set LINKEDIN_PAGES_CLIENT_ID / LINKEDIN_PAGES_CLIENT_SECRET to enable it.'}
                            </p>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>How to connect</CardTitle>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 gap-4 text-sm">
                            <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
                                <li>Click “Generate token” below.</li>
                                <li>Copy the token that appears.</li>
                                <li>
                                    Open the X-Grow extension in Chrome and
                                    paste the token into the popup.
                                </li>
                            </ol>
                            <div className="grid grid-cols-1 gap-1">
                                <span className="text-muted-foreground">
                                    API URL (already set in the extension):
                                </span>
                                <div className="flex items-center gap-2">
                                    <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-sm">
                                        {apiBaseUrl}
                                    </code>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => copy(apiBaseUrl, 'url')}
                                    >
                                        {copied === 'url' ? 'Copied!' : 'Copy'}
                                    </Button>
                                </div>
                            </div>
                            <form onSubmit={generate}>
                                <Button disabled={form.processing}>
                                    Generate token
                                </Button>
                            </form>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Active tokens</CardTitle>
                            <CardDescription>
                                Revoke a token to disconnect that browser.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {tokens.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    No tokens yet.
                                </p>
                            ) : (
                                <ul className="divide-y divide-border">
                                    {tokens.map((token) => (
                                        <li
                                            key={token.id}
                                            className="flex items-center justify-between gap-4 py-3"
                                        >
                                            <div className="min-w-0">
                                                <p className="truncate font-medium">
                                                    {token.name}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    Created {token.created_at} ·{' '}
                                                    {token.last_used_at
                                                        ? `last used ${token.last_used_at}`
                                                        : 'never used'}
                                                </p>
                                            </div>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => revoke(token.id)}
                                            >
                                                Revoke
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </>
    );
}

Connect.layout = {
    breadcrumbs: [{ title: 'Connect extension', href: '/connect' }],
};
