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
            // Ground-truth facts the AI is allowed to state (dates, numbers, stack).
            // Prevents the model from hallucinating specifics like "6 months" when
            // nothing in the profile actually says that.
            $table->text('facts')->nullable()->after('bio_context');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('voice_profiles', function (Blueprint $table) {
            $table->dropColumn('facts');
        });
    }
};
