<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Lets a connected account be paused without disconnecting it — disconnecting
 * discards the OAuth token and orphans every post targeting the account, which
 * is far too destructive for "stop posting here for a while".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('social_accounts', function (Blueprint $table) {
            $table->boolean('is_active')->default(true)->after('kind');
        });
    }

    public function down(): void
    {
        Schema::table('social_accounts', function (Blueprint $table) {
            $table->dropColumn('is_active');
        });
    }
};
