import { Head, Link, router } from '@inertiajs/react';
import {
    Heart,
    MessageCircle,
    Pencil,
    Plus,
    RefreshCw,
    Repeat2,
    Sparkles,
    Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Heading from '@/components/heading';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

type Closeness = 'build' | 'balanced' | 'mine';

// Remix closeness options — kept in sync with PromptBuilder::REMIX_CLOSENESS.
const CLOSENESS_OPTIONS: {
    value: Closeness;
    label: string;
    description: string;
}[] = [
    {
        value: 'build',
        label: 'Build on original',
        description: 'Keep it close, lightly polished',
    },
    {
        value: 'balanced',
        label: 'Balanced',
        description: 'Same shape, your words',
    },
    {
        value: 'mine',
        label: 'Make it mine',
        description: 'Same idea, rewritten fully',
    },
];

type Creator = {
    id: number;
    x_user_id: string;
    username: string;
    name: string | null;
    avatar_url: string | null;
    followers_count: number | null;
    last_scanned_at: string | null;
};

type Metrics = {
    like?: number;
    reply?: number;
    retweet?: number;
    quote?: number;
};

type InspirationPost = {
    id: number;
    creator_id: number;
    username: string;
    name: string | null;
    avatar_url: string | null;
    content: string;
    url: string | null;
    posted_at: string | null;
    metrics: Metrics | null;
    baseline_multiplier: number;
};

type GeneratedDraft = {
    options: string[];
    source: string;
};

// Baseline multiplier badge tiers — bigger outperformance, hotter color.
const baselineColor = (multiplier: number): string => {
    if (multiplier >= 3) {
        return 'bg-red-500 text-white';
    }

    if (multiplier >= 2) {
        return 'bg-orange-500 text-white';
    }

    if (multiplier >= 1.5) {
        return 'bg-violet-500 text-white';
    }

    return 'bg-muted text-muted-foreground';
};

const THRESHOLDS = [
    { value: 'all', label: 'All' },
    { value: '1.5', label: '≥1.5x' },
    { value: '2', label: '≥2x' },
    { value: '3', label: '≥3x' },
];

const formatCount = (n: number): string => {
    if (n >= 1000) {
        return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    }

    return String(n);
};

const initials = (creator: { name: string | null; username: string }): string =>
    (creator.name || creator.username).slice(0, 2).toUpperCase();

// Relative time is client-only (depends on "now") — compute after mount to
// avoid an SSR hydration mismatch (see schedule.tsx's todayKey pattern).
const relativeTime = (iso: string | null, now: number): string => {
    if (!iso) {
        return '';
    }

    const then = new Date(iso).getTime();
    const days = Math.floor((now - then) / 86_400_000);

    if (days <= 0) {
        const hours = Math.floor((now - then) / 3_600_000);

        return hours <= 0 ? 'just now' : `${hours}h ago`;
    }

    if (days < 30) {
        return `${days}d ago`;
    }

    const months = Math.floor(days / 30);

    return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
};

export default function Inspiration({
    creators,
    posts,
    hasXAccount,
}: {
    creators: Creator[];
    posts: InspirationPost[];
    hasXAccount: boolean;
}) {
    const [now, setNow] = useState<number | null>(null);
    const [editingCreators, setEditingCreators] = useState(false);
    const [newHandle, setNewHandle] = useState('');
    const [addingCreator, setAddingCreator] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const [scanning, setScanning] = useState(false);
    const [creatorFilter, setCreatorFilter] = useState('all');
    const [threshold, setThreshold] = useState('all');
    const [remixPost, setRemixPost] = useState<InspirationPost | null>(null);
    const [closeness, setCloseness] = useState<Closeness>('balanced');
    const [instructions, setInstructions] = useState('');
    const [generating, setGenerating] = useState(false);
    const [remixOptions, setRemixOptions] = useState<string[] | null>(null);

    useEffect(() => {
        const update = () => setNow(Date.now());

        update();
        const interval = setInterval(update, 60_000);

        return () => clearInterval(interval);
    }, []);

    const minMultiplier = threshold === 'all' ? 0 : Number(threshold);
    const filtered = posts.filter(
        (post) =>
            (creatorFilter === 'all' ||
                post.creator_id === Number(creatorFilter)) &&
            post.baseline_multiplier >= minMultiplier,
    );

    const updateData = () => {
        setScanning(true);
        router.post(
            '/inspiration/scan',
            {},
            {
                preserveScroll: true,
                onError: (errors) =>
                    toast.error(errors.scan ?? 'Could not update data.'),
                onFinish: () => setScanning(false),
            },
        );
    };

    const addCreator = () => {
        const handle = newHandle.trim();

        if (!handle) {
            return;
        }

        setAddingCreator(true);
        setAddError(null);
        router.post(
            '/inspiration/creators',
            { handle },
            {
                preserveScroll: true,
                onSuccess: () => setNewHandle(''),
                onError: (errors) =>
                    setAddError(errors.handle ?? 'Could not add this creator.'),
                onFinish: () => setAddingCreator(false),
            },
        );
    };

    const removeCreator = (creator: Creator) => {
        router.delete(`/inspiration/creators/${creator.id}`, {
            preserveScroll: true,
        });
    };

    const openRemix = (post: InspirationPost) => {
        setRemixPost(post);
        setCloseness('balanced');
        setInstructions('');
        setRemixOptions(null);
    };

    const generateRemix = () => {
        if (!remixPost) {
            return;
        }

        setGenerating(true);
        router.post(
            `/inspiration/posts/${remixPost.id}/use`,
            {
                closeness,
                instructions: closeness === 'build' ? '' : instructions,
            },
            {
                preserveScroll: true,
                onSuccess: (page) => {
                    const generated = page.props.generatedDraft as
                        GeneratedDraft | null | undefined;

                    if (generated?.options) {
                        setRemixOptions(generated.options);
                    }
                },
                onError: (errors) =>
                    toast.error(errors.use ?? 'Could not generate a draft.'),
                onFinish: () => setGenerating(false),
            },
        );
    };

    const copyDraft = (text: string) => {
        void navigator.clipboard.writeText(text);
        toast.success('Copied to clipboard.');
    };

    return (
        <div className="flex h-full flex-1 flex-col gap-6 p-4">
            <Head title="Inspiration" />

            <div className="flex flex-wrap items-start justify-between gap-3">
                <Heading
                    title="Inspiration"
                    description={`What's working for the ${creators.length} creator${creators.length === 1 ? '' : 's'} you track.`}
                />
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        onClick={updateData}
                        disabled={scanning}
                    >
                        {scanning ? (
                            <Spinner className="size-4" />
                        ) : (
                            <RefreshCw className="size-4" />
                        )}
                        Update data
                    </Button>
                    <Button onClick={() => setEditingCreators(true)}>
                        <Pencil className="size-4" />
                        Edit creators
                    </Button>
                </div>
            </div>

            {!hasXAccount && (
                <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                        <p className="text-sm text-muted-foreground">
                            Connect your X account to look up creators and fetch
                            their viral posts.
                        </p>
                        <Button asChild variant="outline" size="sm">
                            <Link href="/connect">Connect X</Link>
                        </Button>
                    </CardContent>
                </Card>
            )}

            {posts.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                    <Select
                        value={creatorFilter}
                        onValueChange={setCreatorFilter}
                    >
                        <SelectTrigger className="w-52">
                            <SelectValue placeholder="All creators" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All creators</SelectItem>
                            {creators.map((creator) => (
                                <SelectItem
                                    key={creator.id}
                                    value={String(creator.id)}
                                >
                                    @{creator.username}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <ToggleGroup
                        type="single"
                        variant="outline"
                        value={threshold}
                        onValueChange={(value) => value && setThreshold(value)}
                    >
                        {THRESHOLDS.map((t) => (
                            <ToggleGroupItem
                                key={t.value}
                                value={t.value}
                                className="px-3"
                            >
                                {t.label}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                </div>
            )}

            {filtered.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                        <Sparkles className="size-8 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            {creators.length === 0
                                ? 'Add creators to track, then click "Update data" to pull in their viral posts.'
                                : posts.length === 0
                                  ? 'Click "Update data" to fetch the latest viral posts from your tracked creators.'
                                  : 'No posts match these filters. Try lowering the baseline threshold.'}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2">
                    {filtered.map((post) => (
                        <Card key={post.id}>
                            <CardContent className="flex h-full flex-col gap-3 py-4">
                                <div className="flex items-center gap-2">
                                    <Avatar>
                                        {post.avatar_url && (
                                            <AvatarImage
                                                src={post.avatar_url}
                                                alt={post.username}
                                            />
                                        )}
                                        <AvatarFallback>
                                            {initials(post)}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-semibold">
                                            {post.name || post.username}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            @{post.username}
                                        </p>
                                    </div>
                                    <Badge
                                        className={cn(
                                            'shrink-0',
                                            baselineColor(
                                                post.baseline_multiplier,
                                            ),
                                        )}
                                    >
                                        {post.baseline_multiplier}x baseline
                                    </Badge>
                                    {now !== null && post.posted_at && (
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {relativeTime(post.posted_at, now)}
                                        </span>
                                    )}
                                </div>

                                <p className="flex-1 text-sm whitespace-pre-wrap">
                                    {post.content}
                                </p>

                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                        <span className="flex items-center gap-1">
                                            <MessageCircle className="size-3.5" />
                                            {formatCount(
                                                post.metrics?.reply ?? 0,
                                            )}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Heart className="size-3.5" />
                                            {formatCount(
                                                post.metrics?.like ?? 0,
                                            )}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Repeat2 className="size-3.5" />
                                            {formatCount(
                                                post.metrics?.retweet ?? 0,
                                            )}
                                        </span>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => openRemix(post)}
                                    >
                                        <Sparkles className="size-4" />
                                        Use this idea
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* Edit tracked creators */}
            <Dialog open={editingCreators} onOpenChange={setEditingCreators}>
                <DialogContent className="sm:max-w-md">
                    <div className="flex flex-col gap-5">
                        <div>
                            <h2 className="text-xl font-bold">
                                Edit tracked creators
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                {creators.length} tracked · we source viral
                                posts from here.
                            </p>
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-2">
                                <Input
                                    placeholder="Add by @handle"
                                    value={newHandle}
                                    onChange={(e) =>
                                        setNewHandle(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            addCreator();
                                        }
                                    }}
                                    disabled={!hasXAccount}
                                />
                                <Button
                                    onClick={addCreator}
                                    disabled={
                                        addingCreator ||
                                        !hasXAccount ||
                                        !newHandle.trim()
                                    }
                                >
                                    {addingCreator ? (
                                        <Spinner className="size-4" />
                                    ) : (
                                        <Plus className="size-4" />
                                    )}
                                    Add
                                </Button>
                            </div>
                            {addError && (
                                <p className="text-sm text-destructive">
                                    {addError}
                                </p>
                            )}
                            {!hasXAccount && (
                                <p className="text-sm text-muted-foreground">
                                    Connect your X account first to add
                                    creators.
                                </p>
                            )}
                        </div>

                        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                            {creators.length === 0 ? (
                                <p className="py-4 text-center text-sm text-muted-foreground">
                                    No creators tracked yet.
                                </p>
                            ) : (
                                creators.map((creator) => (
                                    <div
                                        key={creator.id}
                                        className="flex items-center gap-2 rounded-md border p-2"
                                    >
                                        <Avatar>
                                            {creator.avatar_url && (
                                                <AvatarImage
                                                    src={creator.avatar_url}
                                                    alt={creator.username}
                                                />
                                            )}
                                            <AvatarFallback>
                                                {initials(creator)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">
                                                {creator.name ||
                                                    creator.username}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                @{creator.username}
                                                {creator.followers_count !=
                                                    null &&
                                                    ` · ${formatCount(creator.followers_count)} followers`}
                                            </p>
                                        </div>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() =>
                                                removeCreator(creator)
                                            }
                                            aria-label={`Stop tracking @${creator.username}`}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Remix this post */}
            <Dialog
                open={remixPost !== null}
                onOpenChange={(open) => !open && setRemixPost(null)}
            >
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                    {remixPost && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-xl font-bold">
                                    Remix this post
                                </h2>
                                <p className="text-sm text-muted-foreground">
                                    Transform this post to match your voice and
                                    style.
                                </p>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                    Original
                                </p>
                                <div className="rounded-md border bg-muted/40 p-3">
                                    <p className="text-sm font-medium">
                                        @{remixPost.username}
                                    </p>
                                    <p className="mt-1 text-sm whitespace-pre-wrap">
                                        {remixPost.content}
                                    </p>
                                </div>
                            </div>

                            <div className="flex flex-col gap-2">
                                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                    How close to the original?
                                </p>
                                <div className="grid grid-cols-3 gap-2">
                                    {CLOSENESS_OPTIONS.map((option) => (
                                        <button
                                            key={option.value}
                                            type="button"
                                            onClick={() =>
                                                setCloseness(option.value)
                                            }
                                            className={cn(
                                                'flex flex-col gap-1 rounded-md border p-3 text-left transition-colors',
                                                closeness === option.value
                                                    ? 'border-primary bg-primary/5'
                                                    : 'hover:bg-muted/50',
                                            )}
                                        >
                                            <span className="text-sm font-semibold">
                                                {option.label}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {option.description}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {closeness !== 'build' && (
                                <div className="flex flex-col gap-1.5">
                                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                        Custom instructions (optional)
                                    </p>
                                    <Textarea
                                        placeholder="e.g., Rewrite this for a fitness audience, or focus on the productivity angle..."
                                        value={instructions}
                                        onChange={(e) =>
                                            setInstructions(e.target.value)
                                        }
                                        rows={2}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Leave empty to use your profile and
                                        interests.
                                    </p>
                                </div>
                            )}

                            {remixOptions && (
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                        Pick a remix
                                    </p>
                                    <div className="flex flex-col gap-3">
                                        {remixOptions.map((option, i) => (
                                            <div
                                                key={i}
                                                className="rounded-md border p-3"
                                            >
                                                <p className="text-sm whitespace-pre-wrap">
                                                    {option}
                                                </p>
                                                <div className="mt-2 flex justify-end">
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            copyDraft(option)
                                                        }
                                                    >
                                                        Copy
                                                    </Button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="flex justify-end">
                                <Button
                                    onClick={generateRemix}
                                    disabled={generating}
                                >
                                    {generating ? (
                                        <Spinner className="size-4" />
                                    ) : (
                                        <Sparkles className="size-4" />
                                    )}
                                    {remixOptions ? 'Regenerate' : 'Generate'}
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

Inspiration.layout = {
    breadcrumbs: [{ title: 'Inspiration', href: '/inspiration' }],
};
