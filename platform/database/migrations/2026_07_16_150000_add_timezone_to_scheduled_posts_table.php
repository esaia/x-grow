<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('scheduled_posts', function (Blueprint $table) {
            // scheduled_at is stored as a naive wall-clock value (see
            // CLAUDE.md) — this remembers which real-world IANA timezone
            // that wall-clock time refers to, so auto-posting can compute
            // the actual due instant instead of comparing naive UTC digits.
            $table->string('timezone')->nullable()->after('scheduled_at');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('scheduled_posts', function (Blueprint $table) {
            $table->dropColumn('timezone');
        });
    }
};
