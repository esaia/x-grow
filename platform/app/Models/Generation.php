<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Generation extends Model
{
    public const TYPE_REPLY = 'reply';
    public const TYPE_POST = 'post';

    protected $fillable = [
        'user_id',
        'type',
        'input_context',
        'meta',
        'output',
        'model',
        'tokens_in',
        'tokens_out',
    ];

    protected $casts = [
        'meta' => 'array',
        'output' => 'array',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
