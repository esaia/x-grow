<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

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
}
