import { Head, Link } from '@inertiajs/react';
import Heading from '@/components/heading';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type Generation = {
    id: number;
    type: 'reply' | 'post';
    input_context: string | null;
    meta: Record<string, unknown> | null;
    output: string[];
    model: string | null;
    created_at: string | null;
};

type Paginated<T> = {
    data: T[];
    links: { url: string | null; label: string; active: boolean }[];
};

export default function History({
    generations,
}: {
    generations: Paginated<Generation>;
}) {
    return (
        <>
            <Head title="History" />

            <div className="flex h-full flex-1 flex-col gap-6 p-4">
                <Heading
                    title="History"
                    description="Every reply and post the AI has generated for you."
                />

                {generations.data.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Nothing yet. Generate a reply or post from the extension
                        and it will show up here.
                    </p>
                ) : (
                    <div className="grid w-full max-w-3xl grid-cols-1 gap-4">
                        {generations.data.map((g) => (
                            <Card key={g.id}>
                                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                                    <CardTitle className="flex min-w-0 flex-1 items-center gap-2 text-base">
                                        <Badge
                                            variant={
                                                g.type === 'reply'
                                                    ? 'secondary'
                                                    : 'default'
                                            }
                                            className="shrink-0 capitalize"
                                        >
                                            {g.type}
                                        </Badge>
                                        <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
                                            {g.input_context}
                                        </span>
                                    </CardTitle>
                                    <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                                        {g.created_at}
                                    </span>
                                </CardHeader>
                                <CardContent className="grid grid-cols-1 gap-2">
                                    {g.output.map((option, i) => (
                                        <p
                                            key={i}
                                            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap"
                                        >
                                            {option}
                                        </p>
                                    ))}
                                </CardContent>
                            </Card>
                        ))}

                        {generations.links.length > 3 && (
                            <div className="flex flex-wrap gap-1">
                                {generations.links.map((link, i) => (
                                    <Link
                                        key={i}
                                        href={link.url ?? '#'}
                                        preserveScroll
                                        className={cn(
                                            'rounded-md border px-3 py-1 text-sm',
                                            link.active
                                                ? 'bg-primary text-primary-foreground'
                                                : 'text-muted-foreground',
                                            !link.url &&
                                                'pointer-events-none opacity-50',
                                        )}
                                        dangerouslySetInnerHTML={{
                                            __html: link.label,
                                        }}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}

History.layout = {
    breadcrumbs: [{ title: 'History', href: '/history' }],
};
