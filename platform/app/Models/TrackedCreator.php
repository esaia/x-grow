<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class TrackedCreator extends Model
{
    protected $fillable = [
        'user_id',
        'x_user_id',
        'username',
        'name',
        'avatar_url',
        'followers_count',
        'last_scanned_at',
    ];

    protected $casts = [
        'followers_count' => 'integer',
        'last_scanned_at' => 'datetime',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function inspirationPosts(): HasMany
    {
        return $this->hasMany(InspirationPost::class);
    }
}
