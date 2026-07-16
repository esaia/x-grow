<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A user's connected X (Twitter) account, used to auto-post scheduled
 * posts on their behalf via the X API. Tokens are stored encrypted since,
 * unlike Sanctum tokens, they must be decryptable to call the X API.
 */
class XAccount extends Model
{
    protected $fillable = [
        'user_id',
        'x_user_id',
        'username',
        'access_token',
        'refresh_token',
        'expires_at',
    ];

    protected $casts = [
        'access_token' => 'encrypted',
        'refresh_token' => 'encrypted',
        'expires_at' => 'datetime',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function isExpired(): bool
    {
        return $this->expires_at->isPast();
    }
}
