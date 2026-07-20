<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tracked_creators', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('x_user_id');
            $table->string('username');
            $table->string('name')->nullable();
            $table->string('avatar_url')->nullable();
            $table->unsignedInteger('followers_count')->nullable();
            $table->timestamp('last_scanned_at')->nullable();
            $table->timestamps();

            $table->unique(['user_id', 'x_user_id']);
            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tracked_creators');
    }
};
