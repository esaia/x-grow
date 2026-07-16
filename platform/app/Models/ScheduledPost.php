<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

class ScheduledPost extends Model
{
    public const STATUS_DRAFT = 'draft';

    public const STATUS_SCHEDULED = 'scheduled';

    public const STATUS_POSTED = 'posted';

    public const STATUS_FAILED = 'failed';

    /** @var array<string, string> */
    public const STATUSES = [
        self::STATUS_DRAFT => 'Draft',
        self::STATUS_SCHEDULED => 'Scheduled',
        self::STATUS_POSTED => 'Posted',
        self::STATUS_FAILED => 'Failed',
    ];

    protected $fillable = [
        'user_id',
        'generation_id',
        'content',
        'category',
        'status',
        'error',
        'scheduled_at',
        'timezone',
        'posted_at',
        'x_tweet_id',
    ];

    protected $casts = [
        'scheduled_at' => 'datetime',
        'posted_at' => 'datetime',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function generation(): BelongsTo
    {
        return $this->belongsTo(Generation::class);
    }

    /**
     * scheduled_at is stored as a naive wall-clock value (see CLAUDE.md) —
     * this reinterprets those digits in the real IANA timezone they were
     * chosen in, giving the actual instant to compare against real "now"
     * for auto-posting. Falls back to the app timezone for older rows
     * created before `timezone` was captured.
     */
    public function realScheduledAt(): Carbon
    {
        return Carbon::parse(
            $this->scheduled_at->format('Y-m-d H:i:s'),
            $this->timezone ?: config('app.timezone'),
        );
    }
}
