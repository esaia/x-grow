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
            // Links/URLs the user may want the AI to reference when relevant.
            $table->text('links')->nullable()->after('bio_context');
            // What the user is currently building / working on.
            $table->text('projects')->nullable()->after('links');
            // Main topics / niche the account is about.
            $table->text('topics')->nullable()->after('projects');
            // The audience the user is trying to reach and grow.
            $table->text('audience')->nullable()->after('topics');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('voice_profiles', function (Blueprint $table) {
            $table->dropColumn(['links', 'projects', 'topics', 'audience']);
        });
    }
};
