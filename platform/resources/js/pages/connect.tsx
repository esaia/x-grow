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

type Token = {
    id: number;
    name: string;
    last_used_at: string | null;
    created_at: string | null;
};

type XAccount = {
    username: string | null;
};

export default function Connect({
    tokens,
    apiBaseUrl,
    newToken,
    xAccount,
}: {
    tokens: Token[];
    apiBaseUrl: string;
    newToken: string | null;
    xAccount: XAccount | null;
}) {
    const { errors } = usePage().props as { errors?: { x?: string } };
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

    const disconnectX = () => {
        router.delete('/connect/x', { preserveScroll: true });
    };

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
                            <CardTitle>Connect your X account</CardTitle>
                            <CardDescription>
                                Required to auto-publish Scheduled posts from
                                the Weekly Schedule at their scheduled time.
                                Without this, posts you approve just stay
                                Scheduled and won't go out on their own.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                            {errors?.x && (
                                <p className="text-sm text-destructive">
                                    {errors.x}
                                </p>
                            )}
                            {xAccount ? (
                                <div className="flex items-center justify-between gap-4">
                                    <p className="text-sm">
                                        Connected as{' '}
                                        <span className="font-medium">
                                            @{xAccount.username}
                                        </span>
                                    </p>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={disconnectX}
                                    >
                                        Disconnect
                                    </Button>
                                </div>
                            ) : (
                                <Button asChild>
                                    <a href="/connect/x/redirect">
                                        Connect X account
                                    </a>
                                </Button>
                            )}
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
