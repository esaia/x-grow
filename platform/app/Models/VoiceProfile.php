<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class VoiceProfile extends Model
{
    protected $fillable = [
        'user_id',
        'tone',
        'sample_posts',
        'dos',
        'donts',
        'bio_context',
        'facts',
        'links',
        'projects',
        'topics',
        'audience',
        'x_handle',
        'voice_analysis',
        'learned_posts',
        'voice_learned_at',
    ];

    protected $casts = [
        'voice_learned_at' => 'datetime',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
