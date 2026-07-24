<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One connected posting destination: an X account, a LinkedIn member, or a
 * LinkedIn company page. A user may connect any number of these. Tokens are
 * stored encrypted since — unlike Sanctum tokens — they must be decryptable
 * to call the provider APIs.
 *
 * Company pages (kind = organization) are connected through a second LinkedIn
 * OAuth app (see ConnectLinkedInPagesController) and so hold their own tokens,
 * exactly like member accounts do.
 */
class SocialAccount extends Model
{
    public const PROVIDER_X = 'x';

    public const PROVIDER_LINKEDIN = 'linkedin';

    public const KIND_PERSON = 'person';

    public const KIND_ORGANIZATION = 'organization';

    protected $fillable = [
        'user_id',
        'provider',
        'kind',
        'is_active',
        'external_id',
        'name',
        'handle',
        'access_token',
        'refresh_token',
        'expires_at',
    ];

    /** Mirrors the column default so freshly-made instances read correctly. */
    protected $attributes = [
        'is_active' => true,
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'access_token' => 'encrypted',
        'refresh_token' => 'encrypted',
        'expires_at' => 'datetime',
    ];

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return HasMany<ScheduledPost, $this> */
    public function scheduledPosts(): HasMany
    {
        return $this->hasMany(ScheduledPost::class);
    }

    public function isExpired(): bool
    {
        return $this->expires_at !== null && $this->expires_at->isPast();
    }

    /**
     * The URN the LinkedIn posts API expects as the post's author.
     */
    public function authorUrn(): string
    {
        return $this->kind === self::KIND_ORGANIZATION
            ? 'urn:li:organization:'.$this->external_id
            : 'urn:li:person:'.$this->external_id;
    }

    /**
     * How this account is named in the UI — "@handle" for X, the display
     * name for LinkedIn members and pages.
     */
    public function label(): string
    {
        if ($this->provider === self::PROVIDER_X) {
            return '@'.($this->handle ?? $this->name ?? $this->external_id);
        }

        return $this->name ?? $this->external_id;
    }

    /** @param  Builder<SocialAccount>  $query */
    public function scopePeople(Builder $query): void
    {
        $query->where('kind', self::KIND_PERSON);
    }

    /**
     * Paused accounts stay connected — tokens intact, posts still pointing at
     * them — but are not offered as targets and never auto-publish.
     *
     * @param  Builder<SocialAccount>  $query
     */
    public function scopeActive(Builder $query): void
    {
        $query->where('is_active', true);
    }
}
