<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class InspirationPost extends Model
{
    protected $fillable = [
        'tracked_creator_id',
        'x_tweet_id',
        'content',
        'url',
        'posted_at',
        'metrics',
        'baseline_multiplier',
    ];

    protected $casts = [
        'posted_at' => 'datetime',
        'metrics' => 'array',
        'baseline_multiplier' => 'float',
    ];

    public function creator(): BelongsTo
    {
        return $this->belongsTo(TrackedCreator::class, 'tracked_creator_id');
    }
}
