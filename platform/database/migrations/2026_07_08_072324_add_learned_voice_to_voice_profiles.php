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
        Schema::table('voice_profiles', function (Blueprint $table) {
            // The user's X handle (without @), captured when learning their voice.
            $table->string('x_handle')->nullable()->after('audience');
            // The model's distilled analysis of the user's writing voice.
            $table->text('voice_analysis')->nullable()->after('x_handle');
            // The raw posts scraped from their profile (for reference / re-analysis).
            $table->longText('learned_posts')->nullable()->after('voice_analysis');
            // When the voice was last learned.
            $table->timestamp('voice_learned_at')->nullable()->after('learned_posts');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('voice_profiles', function (Blueprint $table) {
            $table->dropColumn(['x_handle', 'voice_analysis', 'learned_posts', 'voice_learned_at']);
        });
    }
};
