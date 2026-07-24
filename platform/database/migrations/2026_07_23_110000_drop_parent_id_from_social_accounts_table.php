<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Company pages were originally going to borrow their administering member's
 * token. They can't: LinkedIn's Community Management API refuses to share an
 * app with the sign-in/share products, so pages authenticate through a second
 * OAuth app and own their tokens outright. The delegation column is unused.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('social_accounts', function (Blueprint $table) {
            $table->dropForeign(['parent_id']);
            $table->dropColumn('parent_id');
        });
    }

    public function down(): void
    {
        Schema::table('social_accounts', function (Blueprint $table) {
            $table->foreignId('parent_id')->nullable()->after('kind')
                ->constrained('social_accounts')->cascadeOnDelete();
        });
    }
};
