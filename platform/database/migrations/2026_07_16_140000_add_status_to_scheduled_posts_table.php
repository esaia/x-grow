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
            $table->string('status')->default('draft')->after('category');
            $table->string('error')->nullable()->after('status');
            $table->timestamp('posted_at')->nullable()->after('scheduled_at');
            $table->string('x_tweet_id')->nullable()->after('posted_at');
            $table->index(['status', 'scheduled_at']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('scheduled_posts', function (Blueprint $table) {
            $table->dropIndex(['status', 'scheduled_at']);
            $table->dropColumn(['status', 'error', 'posted_at', 'x_tweet_id']);
        });
    }
};
