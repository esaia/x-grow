<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Creators are now tracked by @handle alone — the extension harvests them
     * from x.com's DOM, which never exposes the numeric user id the X API
     * returned. The handle becomes the natural key.
     */
    public function up(): void
    {
        Schema::table('tracked_creators', function (Blueprint $table) {
            $table->string('x_user_id')->nullable()->change();
            $table->unique(['user_id', 'username']);
        });
    }

    public function down(): void
    {
        Schema::table('tracked_creators', function (Blueprint $table) {
            $table->dropUnique(['user_id', 'username']);
            $table->string('x_user_id')->nullable(false)->change();
        });
    }
};
