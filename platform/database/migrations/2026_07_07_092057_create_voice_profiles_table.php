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
        Schema::create('voice_profiles', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            // Preset tone the AI leans into: e.g. balanced, witty, professional, contrarian, hype.
            $table->string('tone')->default('balanced');
            // A few of the user's best tweets, pasted in — this is what makes output sound like them.
            $table->text('sample_posts')->nullable();
            // Freeform guidance the model must follow / avoid.
            $table->text('dos')->nullable();
            $table->text('donts')->nullable();
            // Who they are / what their account is about (adds relevance to replies).
            $table->text('bio_context')->nullable();
            $table->timestamps();

            $table->unique('user_id'); // one profile per user
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('voice_profiles');
    }
};
