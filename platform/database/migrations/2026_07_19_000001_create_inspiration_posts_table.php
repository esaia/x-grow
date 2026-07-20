<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inspiration_posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tracked_creator_id')->constrained()->cascadeOnDelete();
            $table->string('x_tweet_id');
            $table->text('content');
            $table->string('url')->nullable();
            $table->dateTime('posted_at')->nullable();
            $table->json('metrics')->nullable();
            $table->decimal('baseline_multiplier', 6, 2)->default(0);
            $table->timestamps();

            $table->unique(['tracked_creator_id', 'x_tweet_id']);
            $table->index(['tracked_creator_id', 'baseline_multiplier']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('inspiration_posts');
    }
};
