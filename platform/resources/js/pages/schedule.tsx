import { Head, router, useForm } from '@inertiajs/react';
import {
    CalendarCheck,
    CalendarX,
    ChevronLeft,
    ChevronRight,
    RefreshCw,
    Sparkles,
    Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Heading from '@/components/heading';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type ScheduledPost = {
    id: number;
    content: string;
    category: string | null;
    status: string;
    error: string | null;
    scheduled_at: string;
};

type Category = {
    slug: string;
    label: string;
};

// Colors for the status pill — used both on the compact calendar chip and
// the edit modal — mirrors CATEGORY_COLORS below, kept in sync by hand with
// backend ScheduledPost::STATUSES slugs.
const STATUS_COLORS: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    scheduled: 'bg-emerald-600 text-white',
    posted: 'bg-blue-600 text-white',
    failed: 'bg-red-600 text-white',
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const LEGEND_CATEGORIES_STORAGE_KEY = 'schedule.legendCategories';
const RANGE_STORAGE_KEY = 'schedule.range';

// Rounded, colorful pill per category — matches the legend/badge colors
// backend PromptBuilder::POST_CATEGORIES slugs map to.
const CATEGORY_COLORS: Record<string, string> = {
    question: 'bg-red-500 text-white',
    story: 'bg-blue-500 text-white',
    opinion: 'bg-violet-500 text-white',
    tip: 'bg-emerald-500 text-white',
    promo: 'bg-pink-500 text-white',
    motivation: 'bg-orange-500 text-white',
    news: 'bg-cyan-500 text-white',
};

const FALLBACK_CATEGORY_COLOR = 'bg-muted text-muted-foreground';

// Posts with no category (e.g. created straight from the Inspiration tab) get
// their own vivid card color — indigo, deliberately NOT one of the reserved
// legend hues above (red/blue/violet/emerald/pink/orange/cyan).
const UNCATEGORIZED_COLOR = 'bg-indigo-500 text-white';

// Calendar grid geometry: 24 hourly rows, each ROW_HEIGHT px tall.
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const ROW_HEIGHT = 56;
const CHIP_HEIGHT = 52;

function hourLabel(hour: number): string {
    if (hour === 0) {
        return '12 AM';
    }

    if (hour === 12) {
        return '12 PM';
    }

    return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}

// 15-minute increments across the day, e.g. "12:00 AM", "12:15 AM", ... "11:45 PM".
const START_TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
    const totalMinutes = i * 15;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const period = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const label = `${hour12}:${String(minute).padStart(2, '0')} ${period}`;

    return { value, label };
});

function toLocalDate(dateStr: string, offsetDays: number): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + offsetDays);

    return date;
}

function toDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function mondayOf(date: Date): Date {
    const monday = new Date(date);
    const day = monday.getDay();
    monday.setDate(monday.getDate() + (day === 0 ? -6 : 1 - day));

    return monday;
}

// scheduled_at is a wall-clock time the user picked (e.g. "9:00 AM"), not a
// real instant — read the hour/minute straight out of the string instead of
// going through Date/timeZone conversion, which would shift it around.
function formatTime(scheduledAt: string): string {
    const [hourStr, minuteStr] = scheduledAt.slice(11, 16).split(':');
    const hour = Number(hourStr);
    const period = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;

    return `${hour12}:${minuteStr} ${period}`;
}

function formatWeekRange(weekStart: string): string {
    const start = toLocalDate(weekStart, 0);
    const end = toLocalDate(weekStart, 6);
    const startLabel = start.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });
    const endLabel = end.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

    return `${startLabel} – ${endLabel}`;
}

// e.g. "MONDAY · JUL 13" — used as the modal's day badge.
function formatDayBadge(scheduledAt: string): string {
    const [year, month, day] = scheduledAt.slice(0, 10).split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const weekday = date
        .toLocaleDateString('en-US', { weekday: 'long' })
        .toUpperCase();
    const monthDay = date
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        .toUpperCase();

    return `${weekday} · ${monthDay}`;
}

// Clicking a legend pill excludes/includes that category from the next
// "Generate week" call, so the user can turn off angles they'd rather write
// themselves (e.g. "Share Your Work") for a given week.
function LegendToggle({
    category,
    active,
    onToggle,
}: {
    category: Category;
    active: boolean;
    onToggle: () => void;
}) {
    const color = CATEGORY_COLORS[category.slug] ?? FALLBACK_CATEGORY_COLOR;

    return (
        <button
            type="button"
            onClick={onToggle}
            title={
                active
                    ? 'Click to exclude from generation'
                    : 'Click to include in generation'
            }
            className={cn(
                'cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap transition-opacity',
                active
                    ? color
                    : 'bg-muted text-muted-foreground opacity-50 hover:opacity-75',
            )}
        >
            {category.label}
        </button>
    );
}

// A single selectable pattern option inside the edit modal.
function PatternOption({
    category,
    selected,
    onSelect,
}: {
    category: Category;
    selected: boolean;
    onSelect: () => void;
}) {
    const color = CATEGORY_COLORS[category.slug] ?? FALLBACK_CATEGORY_COLOR;

    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'cursor-pointer rounded-full border px-4 py-2 text-sm font-semibold whitespace-nowrap transition-colors',
                selected
                    ? cn(color, 'border-transparent')
                    : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
            )}
        >
            {category.label}
        </button>
    );
}

// A single scheduled post rendered at its real time slot on the calendar.
function CalendarChip({
    post,
    categories,
    statuses,
    onOpen,
}: {
    post: ScheduledPost;
    categories: Category[];
    statuses: Record<string, string>;
    onOpen: () => void;
}) {
    const color = post.category
        ? (CATEGORY_COLORS[post.category] ?? FALLBACK_CATEGORY_COLOR)
        : UNCATEGORIZED_COLOR;
    const categoryLabel =
        categories.find((c) => c.slug === post.category)?.label ??
        post.category ??
        undefined;
    const statusLabel = statuses[post.status] ?? post.status;
    const [hourStr, minuteStr] = post.scheduled_at.slice(11, 16).split(':');
    const top = (Number(hourStr) + Number(minuteStr) / 60) * ROW_HEIGHT;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={(e) => {
                        // Chips sit on top of the day column's own
                        // click-to-add handler — without this, opening a
                        // post would also open the "Add post" modal behind it.
                        e.stopPropagation();
                        onOpen();
                    }}
                    style={{ top, height: CHIP_HEIGHT }}
                    className={cn(
                        'absolute inset-x-1 cursor-pointer overflow-hidden rounded-md px-2 pt-1 pb-1.5 text-left shadow-sm transition-transform hover:z-10 hover:scale-[1.02]',
                        color,
                    )}
                >
                    <div className="flex min-w-0 items-center gap-1">
                        {/* min-w-0 + truncate lets the time give up space
                            first — the status label is shrink-0 so it
                            always renders in full instead of getting
                            clipped by this chip's overflow-hidden on
                            narrow columns. */}
                        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold opacity-90">
                            {formatTime(post.scheduled_at)}
                        </span>
                        <span
                            className={cn(
                                'shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold tracking-wide whitespace-nowrap uppercase',
                                STATUS_COLORS[post.status] ??
                                    FALLBACK_CATEGORY_COLOR,
                            )}
                        >
                            {statusLabel}
                        </span>
                    </div>
                    <div className="line-clamp-2 text-[11px] leading-tight font-medium">
                        {post.content}
                    </div>
                </button>
            </TooltipTrigger>
            <TooltipContent
                side="right"
                className="max-w-xs whitespace-pre-wrap"
            >
                <p className="mb-1 font-semibold">
                    {formatTime(post.scheduled_at)}
                    {categoryLabel ? ` · ${categoryLabel}` : ''}
                    {` · ${statusLabel}`}
                </p>
                <p>{post.content}</p>
                {post.status === 'failed' && post.error && (
                    <p className="mt-1 text-destructive">{post.error}</p>
                )}
            </TooltipContent>
        </Tooltip>
    );
}

export default function Schedule({
    weekStart,
    posts,
    categories,
    statuses,
}: {
    weekStart: string;
    posts: ScheduledPost[];
    categories: Category[];
    statuses: Record<string, string>;
}) {
    const form = useForm({
        week_start: weekStart,
        range_start: '10:00',
        range_end: '22:00',
        per_day: 3,
        categories: categories.map((c) => c.slug),
    });

    // Which legend categories are toggled on/off persists across page
    // refreshes — without this every reload re-enables all categories,
    // discarding the user's chosen set. Loaded client-side only (after the
    // SSR/hydration render, which must match the server's all-enabled
    // markup) and re-saved whenever it changes.
    useEffect(() => {
        const saved = window.localStorage.getItem(
            LEGEND_CATEGORIES_STORAGE_KEY,
        );

        if (!saved) {
            return;
        }

        try {
            const parsed = JSON.parse(saved);

            if (
                Array.isArray(parsed) &&
                parsed.every((slug) => typeof slug === 'string')
            ) {
                const valid = parsed.filter((slug) =>
                    categories.some((c) => c.slug === slug),
                );

                if (valid.length > 0) {
                    form.setData('categories', valid);
                }
            }
        } catch {
            // ignore malformed storage
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The From/To generation time range persists across page refreshes the
    // same way the legend categories do above — loaded client-side only
    // after hydration, then re-saved whenever either value changes.
    useEffect(() => {
        const saved = window.localStorage.getItem(RANGE_STORAGE_KEY);

        if (!saved) {
            return;
        }

        try {
            const parsed = JSON.parse(saved);

            if (
                parsed &&
                typeof parsed.range_start === 'string' &&
                typeof parsed.range_end === 'string'
            ) {
                form.setData((data) => ({
                    ...data,
                    range_start: parsed.range_start,
                    range_end: parsed.range_end,
                }));
            }
        } catch {
            // ignore malformed storage
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // scheduled_at is stored as a naive wall-clock value — the browser's own
    // IANA timezone is sent alongside it so the backend can later compute
    // the real due instant for auto-posting (see ScheduledPost::realScheduledAt).
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const [editingPost, setEditingPost] = useState<ScheduledPost | null>(null);
    const [draftContent, setDraftContent] = useState('');
    const [draftCategory, setDraftCategory] = useState('');
    const [draftTime, setDraftTime] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [regenerating, setRegenerating] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
    const [draftStatus, setDraftStatus] = useState('draft');
    const [scheduling, setScheduling] = useState(false);
    const [schedulingAll, setSchedulingAll] = useState(false);
    const [emptyingWeek, setEmptyingWeek] = useState(false);
    const [confirmEmptyWeek, setConfirmEmptyWeek] = useState(false);

    // Clicking an empty spot on the calendar opens this modal, pre-filled
    // with the day/time that was clicked, to either write a post by hand or
    // generate one on the spot.
    const [addSlot, setAddSlot] = useState<{
        date: string;
        time: string;
    } | null>(null);
    const [addContent, setAddContent] = useState('');
    const [addCategory, setAddCategory] = useState('');
    const [addSaving, setAddSaving] = useState(false);
    const [addGenerating, setAddGenerating] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);

    // "Today" and the live now-line are computed client-side only — the
    // server and browser clocks/timezones can disagree, and computing this
    // during SSR would cause a hydration mismatch (see formatWeekRange's
    // sibling bug history). Null until mounted means no highlight on first
    // paint, matching the server-rendered markup exactly.
    const [todayKey, setTodayKey] = useState<string | null>(null);
    const [nowOffset, setNowOffset] = useState<number | null>(null);

    useEffect(() => {
        const update = () => {
            const now = new Date();
            setTodayKey(toDateKey(now));
            setNowOffset((now.getHours() + now.getMinutes() / 60) * ROW_HEIGHT);
        };

        update();
        const interval = setInterval(update, 60_000);

        return () => clearInterval(interval);
    }, []);

    const weekHasPosts = posts.length > 0;

    const scrollRef = useRef<HTMLDivElement>(null);

    // The day header row lives outside the scrollable grid below it, so it
    // never has a scrollbar — but the grid does once its content overflows
    // max-h-[65vh]. Without compensating, the scrollbar's width shrinks the
    // grid's 7 columns relative to the header's, and the misalignment grows
    // toward the right-hand days (Sat/Sun). Measure it and pad the header by
    // the same amount so both rows' columns line up on every platform.
    const [scrollbarWidth, setScrollbarWidth] = useState(0);

    useLayoutEffect(() => {
        const measure = () => {
            if (scrollRef.current) {
                setScrollbarWidth(
                    scrollRef.current.offsetWidth -
                        scrollRef.current.clientWidth,
                );
            }
        };

        measure();
        window.addEventListener('resize', measure);

        return () => window.removeEventListener('resize', measure);
    }, [posts]);

    // Scroll the earliest post of the week to the top of the grid — on week
    // navigation, and the moment a week goes from empty to freshly
    // generated. Not on every in-place edit/regenerate, which would jerk the
    // view around while someone is working on a post.
    useLayoutEffect(() => {
        if (!scrollRef.current) {
            return;
        }

        const hours = posts.map((post) =>
            Number(post.scheduled_at.slice(11, 13)),
        );
        const earliestHour = hours.length > 0 ? Math.min(...hours) : 8;
        scrollRef.current.scrollTop = earliestHour * ROW_HEIGHT;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weekStart, weekHasPosts]);

    const setRange = (key: 'range_start' | 'range_end', value: string) => {
        form.setData(key, value);
        window.localStorage.setItem(
            RANGE_STORAGE_KEY,
            JSON.stringify({
                range_start:
                    key === 'range_start' ? value : form.data.range_start,
                range_end: key === 'range_end' ? value : form.data.range_end,
            }),
        );
    };

    const toggleCategory = (slug: string) => {
        const current = form.data.categories;
        const isEnabled = current.includes(slug);

        // Always keep at least one category enabled.
        if (isEnabled && current.length === 1) {
            return;
        }

        const next = isEnabled
            ? current.filter((c) => c !== slug)
            : [...current, slug];

        form.setData('categories', next);
        window.localStorage.setItem(
            LEGEND_CATEGORIES_STORAGE_KEY,
            JSON.stringify(next),
        );
    };

    const goToWeek = (offsetDays: number) => {
        const target = toLocalDate(weekStart, offsetDays);
        router.get(
            '/schedule',
            { week: toDateKey(target) },
            { preserveScroll: true },
        );
    };

    const goToThisWeek = () => {
        router.get(
            '/schedule',
            { week: toDateKey(mondayOf(new Date())) },
            { preserveScroll: true },
        );
    };

    const generate = (e: React.FormEvent) => {
        e.preventDefault();

        if (weekHasPosts) {
            return;
        }

        form.transform((data) => ({
            ...data,
            week_start: weekStart,
            timezone,
        }));
        form.post('/schedule/generate', { preserveScroll: true });
    };

    const openPost = (post: ScheduledPost) => {
        setEditingPost(post);
        setDraftContent(post.content);
        setDraftCategory(post.category ?? categories[0]?.slug ?? '');
        setDraftTime(post.scheduled_at.slice(11, 16));
        setDraftStatus(post.status);
        setSaveError(null);
    };

    const closeModal = () => setEditingPost(null);

    // Opens the "Add post" modal for the day column that was clicked, at the
    // hour implied by the click's vertical position, snapped to 15 minutes.
    const openAddSlot = (
        dayIndex: number,
        e: React.MouseEvent<HTMLDivElement>,
    ) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const offsetY = e.clientY - rect.top;
        const totalMinutes = (offsetY / ROW_HEIGHT) * 60;
        const snapped = Math.min(
            23 * 60 + 45,
            Math.max(0, Math.round(totalMinutes / 15) * 15),
        );
        const hour = Math.floor(snapped / 60);
        const minute = snapped % 60;

        setAddSlot({
            date: toDateKey(toLocalDate(weekStart, dayIndex)),
            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        });
        setAddContent('');
        setAddCategory(categories[0]?.slug ?? '');
        setAddError(null);
    };

    const closeAddModal = () => setAddSlot(null);

    const addManualPost = () => {
        if (!addSlot) {
            return;
        }

        setAddSaving(true);
        setAddError(null);
        router.post(
            '/schedule/posts',
            {
                content: addContent,
                category: addCategory,
                date: addSlot.date,
                time: addSlot.time,
                timezone,
            },
            {
                preserveScroll: true,
                onSuccess: () => closeAddModal(),
                onError: (errors) =>
                    setAddError(errors.time ?? 'Could not add this post.'),
                onFinish: () => setAddSaving(false),
            },
        );
    };

    const generateAndAddPost = () => {
        if (!addSlot) {
            return;
        }

        setAddGenerating(true);
        setAddError(null);
        router.post(
            '/schedule/posts/generate-one',
            {
                category: addCategory,
                date: addSlot.date,
                time: addSlot.time,
                timezone,
            },
            {
                preserveScroll: true,
                // Fills the content field for review/editing — it does not
                // save the post. The modal stays open; "Add post" saves it.
                onSuccess: (page) => {
                    const generated = page.props.generatedDraft as
                        | { content: string; category: string }
                        | null
                        | undefined;

                    if (generated) {
                        setAddContent(generated.content);
                        setAddCategory(generated.category);
                    }
                },
                onError: (errors) =>
                    setAddError(
                        errors.time ??
                            errors.generate ??
                            'Could not generate this post.',
                    ),
                onFinish: () => setAddGenerating(false),
            },
        );
    };

    const saveChanges = () => {
        if (!editingPost) {
            return;
        }

        setSaving(true);
        setSaveError(null);
        router.put(
            `/schedule/posts/${editingPost.id}`,
            {
                content: draftContent,
                category: draftCategory,
                time: draftTime,
                timezone,
            },
            {
                preserveScroll: true,
                onSuccess: () => closeModal(),
                onError: (errors) =>
                    setSaveError(errors.time ?? 'Could not save changes.'),
                onFinish: () => setSaving(false),
            },
        );
    };

    const regenerate = () => {
        if (!editingPost) {
            return;
        }

        setRegenerating(true);
        setSaveError(null);
        router.post(
            `/schedule/posts/${editingPost.id}/regenerate`,
            { category: draftCategory },
            {
                preserveScroll: true,
                onSuccess: (page) => {
                    const updated = (page.props.posts as ScheduledPost[]).find(
                        (p) => p.id === editingPost.id,
                    );

                    if (updated) {
                        setDraftContent(updated.content);
                        setDraftCategory(updated.category ?? draftCategory);
                        setDraftStatus(updated.status);
                    }
                },
                onError: (errors) =>
                    setSaveError(
                        errors.regenerate ?? 'Could not regenerate this post.',
                    ),
                onFinish: () => setRegenerating(false),
            },
        );
    };

    const scheduleOne = () => {
        if (!editingPost) {
            return;
        }

        setScheduling(true);
        router.post(
            `/schedule/posts/${editingPost.id}/schedule`,
            {},
            {
                preserveScroll: true,
                onSuccess: () => setDraftStatus('scheduled'),
                onFinish: () => setScheduling(false),
            },
        );
    };

    const unscheduleOne = () => {
        if (!editingPost) {
            return;
        }

        setScheduling(true);
        router.post(
            `/schedule/posts/${editingPost.id}/unschedule`,
            {},
            {
                preserveScroll: true,
                onSuccess: () => setDraftStatus('draft'),
                onFinish: () => setScheduling(false),
            },
        );
    };

    const scheduleAllDrafts = () => {
        setSchedulingAll(true);
        router.post(
            '/schedule/schedule-all',
            { week_start: weekStart },
            {
                preserveScroll: true,
                onFinish: () => setSchedulingAll(false),
            },
        );
    };

    const emptyWeek = () => {
        setEmptyingWeek(true);
        router.post(
            '/schedule/empty-week',
            { week_start: weekStart },
            {
                preserveScroll: true,
                onFinish: () => setEmptyingWeek(false),
            },
        );
        setConfirmEmptyWeek(false);
    };

    const confirmDelete = () => {
        if (deleteTarget === null) {
            return;
        }

        router.delete(`/schedule/posts/${deleteTarget}`, {
            preserveScroll: true,
            onSuccess: () => {
                if (editingPost?.id === deleteTarget) {
                    closeModal();
                }
            },
        });
        setDeleteTarget(null);
    };

    const postsByDay = DAY_LABELS.map((_, i) => {
        const key = toDateKey(toLocalDate(weekStart, i));

        return posts.filter((post) => post.scheduled_at.slice(0, 10) === key);
    });

    return (
        <>
            <Head title="Weekly Schedule" />

            <div className="flex h-full flex-1 flex-col gap-6 p-4">
                <Heading
                    title="Weekly Schedule"
                    description="Generate a week's worth of AI-written draft posts, spaced out across the days."
                    className="mb-0"
                />

                <Card className="w-full">
                    <CardContent className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-end gap-4">
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => goToWeek(-7)}
                                >
                                    <ChevronLeft className="size-4" />
                                </Button>
                                <div className="text-sm font-medium whitespace-nowrap">
                                    Week of {formatWeekRange(weekStart)}
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => goToWeek(7)}
                                >
                                    <ChevronRight className="size-4" />
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={goToThisWeek}
                                >
                                    Current week
                                </Button>
                            </div>

                            <form
                                onSubmit={generate}
                                className="flex flex-wrap items-end gap-4"
                            >
                                <div className="grid gap-1.5">
                                    <Label htmlFor="range_start">From</Label>
                                    <Select
                                        value={form.data.range_start}
                                        onValueChange={(value) =>
                                            setRange('range_start', value)
                                        }
                                    >
                                        <SelectTrigger
                                            id="range_start"
                                            className="w-28"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="max-h-72">
                                            {START_TIME_OPTIONS.map(
                                                (option) => (
                                                    <SelectItem
                                                        key={option.value}
                                                        value={option.value}
                                                    >
                                                        {option.label}
                                                    </SelectItem>
                                                ),
                                            )}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid gap-1.5">
                                    <Label htmlFor="range_end">To</Label>
                                    <Select
                                        value={form.data.range_end}
                                        onValueChange={(value) =>
                                            setRange('range_end', value)
                                        }
                                    >
                                        <SelectTrigger
                                            id="range_end"
                                            className="w-28"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="max-h-72">
                                            {START_TIME_OPTIONS.map(
                                                (option) => (
                                                    <SelectItem
                                                        key={option.value}
                                                        value={option.value}
                                                    >
                                                        {option.label}
                                                    </SelectItem>
                                                ),
                                            )}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid w-36 gap-1.5">
                                    <Label>Per day · {form.data.per_day}</Label>
                                    <Slider
                                        min={1}
                                        max={6}
                                        step={1}
                                        value={[form.data.per_day]}
                                        onValueChange={([value]) =>
                                            form.setData('per_day', value)
                                        }
                                        className="py-1.5"
                                    />
                                </div>

                                <Button
                                    type="submit"
                                    disabled={form.processing || weekHasPosts}
                                    title={
                                        weekHasPosts
                                            ? 'This week already has posts — edit or delete them below, or switch weeks.'
                                            : undefined
                                    }
                                >
                                    {form.processing ? (
                                        <Spinner className="size-4" />
                                    ) : (
                                        <Sparkles className="size-4" />
                                    )}
                                    Generate week
                                </Button>
                            </form>

                            {weekHasPosts && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={
                                        schedulingAll ||
                                        !posts.some((p) => p.status === 'draft')
                                    }
                                    onClick={scheduleAllDrafts}
                                    title="Schedule every remaining draft post this week so it auto-publishes at its time"
                                >
                                    {schedulingAll ? (
                                        <Spinner className="size-4" />
                                    ) : (
                                        <CalendarCheck className="size-4" />
                                    )}
                                    Schedule all drafts
                                </Button>
                            )}

                            {weekHasPosts && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={emptyingWeek}
                                    onClick={() => setConfirmEmptyWeek(true)}
                                    title="Delete every post this week so it can be generated from scratch"
                                >
                                    {emptyingWeek ? (
                                        <Spinner className="size-4" />
                                    ) : (
                                        <Trash2 className="size-4" />
                                    )}
                                    Empty week
                                </Button>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                Legend
                            </span>
                            {categories.map((category) => (
                                <LegendToggle
                                    key={category.slug}
                                    category={category}
                                    active={form.data.categories.includes(
                                        category.slug,
                                    )}
                                    onToggle={() =>
                                        toggleCategory(category.slug)
                                    }
                                />
                            ))}
                        </div>
                    </CardContent>
                </Card>

                <Card className="relative flex w-full flex-col gap-0 overflow-hidden py-0">
                    {!weekHasPosts && (
                        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                            <p className="rounded-md bg-card/90 px-4 py-2 text-sm text-muted-foreground shadow-sm">
                                No posts yet — generate this week to fill the
                                calendar.
                            </p>
                        </div>
                    )}

                    {/* Day header row, aligned to the hour rail + 7 day columns below.
                        paddingRight compensates for the scrollable grid's scrollbar
                        (see scrollbarWidth above) so both rows' columns line up. */}
                    <div
                        className="flex border-b border-border"
                        style={{ paddingRight: scrollbarWidth }}
                    >
                        <div className="w-14 shrink-0" />
                        <div className="grid flex-1 grid-cols-7">
                            {DAY_LABELS.map((label, i) => {
                                const date = toLocalDate(weekStart, i);
                                const isToday = todayKey === toDateKey(date);

                                return (
                                    <div
                                        key={label}
                                        className="flex flex-col items-center gap-1 border-l border-border py-2 first:border-l-0"
                                    >
                                        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                                            {label}
                                        </span>
                                        <span
                                            className={cn(
                                                'flex size-7 items-center justify-center rounded-full text-sm font-semibold',
                                                isToday &&
                                                    'bg-primary text-primary-foreground',
                                            )}
                                        >
                                            {date.getDate()}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Scrollable 24-hour grid. */}
                    <div
                        ref={scrollRef}
                        className="flex max-h-[65vh] overflow-y-auto"
                    >
                        <div className="w-14 shrink-0">
                            {HOURS.map((hour) => (
                                <div
                                    key={hour}
                                    style={{ height: ROW_HEIGHT }}
                                    className="-translate-y-1/2 pr-2 text-right text-[11px] text-muted-foreground"
                                >
                                    {hour === 0 ? '' : hourLabel(hour)}
                                </div>
                            ))}
                        </div>

                        <div className="grid flex-1 grid-cols-7">
                            {DAY_LABELS.map((label, i) => {
                                const date = toLocalDate(weekStart, i);
                                const dayKey = toDateKey(date);
                                const isToday = todayKey === dayKey;

                                return (
                                    <div
                                        key={label}
                                        onClick={(e) => openAddSlot(i, e)}
                                        className="relative cursor-pointer border-l border-border first:border-l-0 hover:bg-muted/30"
                                        style={{
                                            height: HOURS.length * ROW_HEIGHT,
                                        }}
                                    >
                                        {HOURS.map((hour) => (
                                            <div
                                                key={hour}
                                                style={{ height: ROW_HEIGHT }}
                                                className="border-t border-border/50"
                                            />
                                        ))}

                                        {postsByDay[i].map((post) => (
                                            <CalendarChip
                                                key={post.id}
                                                post={post}
                                                categories={categories}
                                                statuses={statuses}
                                                onOpen={() => openPost(post)}
                                            />
                                        ))}

                                        {isToday && nowOffset !== null && (
                                            <div
                                                style={{ top: nowOffset }}
                                                className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                                            >
                                                <span className="-ml-1 size-2 rounded-full bg-red-500" />
                                                <span className="h-px flex-1 bg-red-500" />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </Card>
            </div>

            <Dialog
                open={editingPost !== null}
                onOpenChange={(open) => !open && closeModal()}
            >
                <DialogContent className="sm:max-w-md">
                    {editingPost && (
                        <div className="flex flex-col gap-5">
                            <div className="flex items-center justify-between">
                                <span className="rounded-full bg-primary px-4 py-1.5 text-xs font-bold whitespace-nowrap text-primary-foreground">
                                    {formatDayBadge(editingPost.scheduled_at)}
                                </span>
                                <span
                                    className={cn(
                                        'rounded-full px-3 py-1 text-xs font-bold tracking-wide whitespace-nowrap uppercase',
                                        STATUS_COLORS[draftStatus] ??
                                            FALLBACK_CATEGORY_COLOR,
                                    )}
                                >
                                    {statuses[draftStatus] ?? draftStatus}
                                </span>
                            </div>

                            {draftStatus === 'failed' && editingPost.error && (
                                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                    {editingPost.error}
                                </p>
                            )}

                            <h2 className="text-xl font-bold">
                                {draftStatus === 'posted'
                                    ? 'Posted tweet'
                                    : 'Edit tweet'}
                            </h2>

                            {draftStatus === 'posted' ? (
                                <>
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                            Time
                                        </Label>
                                        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                                            {formatTime(
                                                editingPost.scheduled_at,
                                            )}
                                        </p>
                                    </div>

                                    <div className="grid gap-1.5">
                                        <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                            Pattern
                                        </Label>
                                        <span
                                            className={cn(
                                                'w-fit rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap',
                                                editingPost.category
                                                    ? (CATEGORY_COLORS[
                                                          editingPost.category
                                                      ] ??
                                                          FALLBACK_CATEGORY_COLOR)
                                                    : UNCATEGORIZED_COLOR,
                                            )}
                                        >
                                            {categories.find(
                                                (c) =>
                                                    c.slug ===
                                                    editingPost.category,
                                            )?.label ??
                                                editingPost.category ??
                                                'Uncategorized'}
                                        </span>
                                    </div>

                                    <div className="grid gap-1.5">
                                        <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                            Content
                                        </Label>
                                        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">
                                            {editingPost.content}
                                        </p>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                            Time
                                        </Label>
                                        <Select
                                            value={draftTime}
                                            onValueChange={(value) => {
                                                setDraftTime(value);
                                                setSaveError(null);
                                            }}
                                        >
                                            <SelectTrigger className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-72">
                                                {START_TIME_OPTIONS.map(
                                                    (option) => (
                                                        <SelectItem
                                                            key={option.value}
                                                            value={option.value}
                                                        >
                                                            {option.label}
                                                        </SelectItem>
                                                    ),
                                                )}
                                            </SelectContent>
                                        </Select>
                                        {saveError && (
                                            <p className="text-xs text-destructive">
                                                {saveError}
                                            </p>
                                        )}
                                    </div>

                                    <div className="grid gap-1.5">
                                        <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                            Pattern
                                        </Label>
                                        <div className="flex flex-wrap gap-2">
                                            {categories.map((category) => (
                                                <PatternOption
                                                    key={category.slug}
                                                    category={category}
                                                    selected={
                                                        draftCategory ===
                                                        category.slug
                                                    }
                                                    onSelect={() =>
                                                        setDraftCategory(
                                                            category.slug,
                                                        )
                                                    }
                                                />
                                            ))}
                                        </div>
                                    </div>

                                    <div className="grid gap-1.5">
                                        <div className="flex items-center justify-between">
                                            <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                                Content
                                            </Label>
                                            <span className="text-xs text-muted-foreground">
                                                {draftContent.length}/280
                                            </span>
                                        </div>
                                        <Textarea
                                            value={draftContent}
                                            onChange={(e) =>
                                                setDraftContent(e.target.value)
                                            }
                                            className="min-h-32"
                                        />
                                    </div>
                                </>
                            )}

                            {draftStatus !== 'posted' && (
                                <Button
                                    type="button"
                                    variant={
                                        draftStatus === 'scheduled'
                                            ? 'outline'
                                            : 'default'
                                    }
                                    disabled={
                                        scheduling ||
                                        (draftStatus !== 'scheduled' &&
                                            new Date(
                                                editingPost.scheduled_at,
                                            ) <= new Date())
                                    }
                                    onClick={
                                        draftStatus === 'scheduled'
                                            ? unscheduleOne
                                            : scheduleOne
                                    }
                                    title={
                                        draftStatus !== 'scheduled' &&
                                        new Date(editingPost.scheduled_at) <=
                                            new Date()
                                            ? 'This slot is already in the past — edit the time first.'
                                            : undefined
                                    }
                                >
                                    {scheduling ? (
                                        <Spinner className="size-4" />
                                    ) : draftStatus === 'scheduled' ? (
                                        <CalendarX className="size-4" />
                                    ) : (
                                        <CalendarCheck className="size-4" />
                                    )}
                                    {draftStatus === 'scheduled'
                                        ? 'Unschedule'
                                        : draftStatus === 'failed'
                                          ? 'Retry'
                                          : 'Schedule'}
                                </Button>
                            )}

                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() =>
                                        setDeleteTarget(editingPost.id)
                                    }
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                                {draftStatus !== 'posted' && (
                                    <>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="flex-1"
                                            disabled={regenerating}
                                            onClick={regenerate}
                                        >
                                            {regenerating ? (
                                                <Spinner className="size-4" />
                                            ) : (
                                                <RefreshCw className="size-4" />
                                            )}
                                            Re-generate
                                        </Button>
                                        <Button
                                            type="button"
                                            className="flex-1"
                                            disabled={
                                                saving ||
                                                draftContent.trim() === ''
                                            }
                                            onClick={saveChanges}
                                        >
                                            {saving && (
                                                <Spinner className="size-4" />
                                            )}
                                            Save changes
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <Dialog
                open={addSlot !== null}
                onOpenChange={(open) => !open && closeAddModal()}
            >
                <DialogContent className="sm:max-w-md">
                    {addSlot && (
                        <div className="flex flex-col gap-5">
                            <span className="w-fit rounded-full bg-primary px-4 py-1.5 text-xs font-bold whitespace-nowrap text-primary-foreground">
                                {formatDayBadge(addSlot.date)}
                            </span>

                            <h2 className="text-xl font-bold">Add post</h2>

                            <div className="grid gap-1.5">
                                <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                    Time
                                </Label>
                                <Select
                                    value={addSlot.time}
                                    onValueChange={(value) => {
                                        setAddSlot({ ...addSlot, time: value });
                                        setAddError(null);
                                    }}
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-72">
                                        {START_TIME_OPTIONS.map((option) => (
                                            <SelectItem
                                                key={option.value}
                                                value={option.value}
                                            >
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {addError && (
                                    <p className="text-xs text-destructive">
                                        {addError}
                                    </p>
                                )}
                            </div>

                            <div className="grid gap-1.5">
                                <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                    Pattern
                                </Label>
                                <div className="flex flex-wrap gap-2">
                                    {categories.map((category) => (
                                        <PatternOption
                                            key={category.slug}
                                            category={category}
                                            selected={
                                                addCategory === category.slug
                                            }
                                            onSelect={() =>
                                                setAddCategory(category.slug)
                                            }
                                        />
                                    ))}
                                </div>
                            </div>

                            <div className="grid gap-1.5">
                                <div className="flex items-center justify-between">
                                    <Label className="text-xs tracking-wide text-muted-foreground uppercase">
                                        Content
                                    </Label>
                                    <span className="text-xs text-muted-foreground">
                                        {addContent.length}/280
                                    </span>
                                </div>
                                <Textarea
                                    value={addContent}
                                    onChange={(e) =>
                                        setAddContent(e.target.value)
                                    }
                                    placeholder="Write it yourself, or generate one with AI below."
                                    className="min-h-32"
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="flex-1"
                                    disabled={addGenerating || addSaving}
                                    onClick={generateAndAddPost}
                                >
                                    {addGenerating ? (
                                        <Spinner className="size-4" />
                                    ) : (
                                        <Sparkles className="size-4" />
                                    )}
                                    Generate with AI
                                </Button>
                                <Button
                                    type="button"
                                    className="flex-1"
                                    disabled={
                                        addSaving ||
                                        addGenerating ||
                                        addContent.trim() === ''
                                    }
                                    onClick={addManualPost}
                                >
                                    {addSaving && (
                                        <Spinner className="size-4" />
                                    )}
                                    Add post
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <AlertDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && setDeleteTarget(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this post?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This draft will be permanently removed from the
                            schedule. This can't be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={confirmDelete}>
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog
                open={confirmEmptyWeek}
                onOpenChange={(open) => !open && setConfirmEmptyWeek(false)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Empty this week?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Every post this week — including scheduled and
                            already-posted ones — will be permanently removed.
                            This can't be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={emptyWeek}>
                            Empty week
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

Schedule.layout = {
    breadcrumbs: [{ title: 'Weekly Schedule', href: '/schedule' }],
};
