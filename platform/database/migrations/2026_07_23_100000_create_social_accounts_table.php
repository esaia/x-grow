<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Replaces the one-row-per-user x_accounts / linkedin_accounts tables with a
 * single table that holds any number of connected accounts per user, across
 * networks, including LinkedIn company pages (kind = organization).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('social_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('provider');
            // person = the member/user themselves; organization = a LinkedIn
            // company page they administer, which posts using its parent
            // member account's token.
            $table->string('kind')->default('person');
            $table->foreignId('parent_id')->nullable()->constrained('social_accounts')->cascadeOnDelete();
            $table->string('external_id');
            $table->string('name')->nullable();
            $table->string('handle')->nullable();
            $table->text('access_token')->nullable();
            $table->text('refresh_token')->nullable();
            $table->timestamp('expires_at')->nullable();
            $table->timestamps();

            $table->unique(['user_id', 'provider', 'external_id']);
        });

        // Carry existing connections over. Tokens are copied as-is: the
        // `encrypted` cast is symmetric under the same APP_KEY, so the stored
        // ciphertext stays readable in the new table.
        foreach (DB::table('x_accounts')->get() as $account) {
            DB::table('social_accounts')->insert([
                'user_id' => $account->user_id,
                'provider' => 'x',
                'kind' => 'person',
                'external_id' => $account->x_user_id,
                'name' => $account->username,
                'handle' => $account->username,
                'access_token' => $account->access_token,
                'refresh_token' => $account->refresh_token,
                'expires_at' => $account->expires_at,
                'created_at' => $account->created_at,
                'updated_at' => $account->updated_at,
            ]);
        }

        foreach (DB::table('linkedin_accounts')->get() as $account) {
            DB::table('social_accounts')->insert([
                'user_id' => $account->user_id,
                'provider' => 'linkedin',
                'kind' => 'person',
                'external_id' => $account->linkedin_user_id,
                'name' => $account->name,
                'handle' => null,
                'access_token' => $account->access_token,
                'refresh_token' => $account->refresh_token,
                'expires_at' => $account->expires_at,
                'created_at' => $account->created_at,
                'updated_at' => $account->updated_at,
            ]);
        }

        Schema::table('scheduled_posts', function (Blueprint $table) {
            // Null means the target account was disconnected — the post keeps
            // its platform and content, but can't publish until retargeted.
            $table->foreignId('social_account_id')->nullable()->after('platform')
                ->constrained('social_accounts')->nullOnDelete();
        });

        // Point existing posts at their user's account on the same network.
        foreach (DB::table('social_accounts')->where('kind', 'person')->get() as $account) {
            DB::table('scheduled_posts')
                ->where('user_id', $account->user_id)
                ->where('platform', $account->provider)
                ->update(['social_account_id' => $account->id]);
        }

        Schema::dropIfExists('x_accounts');
        Schema::dropIfExists('linkedin_accounts');
    }

    public function down(): void
    {
        Schema::create('x_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('x_user_id');
            $table->string('username')->nullable();
            $table->text('access_token');
            $table->text('refresh_token')->nullable();
            $table->timestamp('expires_at');
            $table->timestamps();
            $table->unique('user_id');
        });

        Schema::create('linkedin_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('linkedin_user_id');
            $table->string('name')->nullable();
            $table->text('access_token');
            $table->text('refresh_token')->nullable();
            $table->timestamp('expires_at');
            $table->timestamps();
        });

        Schema::table('scheduled_posts', function (Blueprint $table) {
            $table->dropForeign(['social_account_id']);
            $table->dropColumn('social_account_id');
        });

        Schema::dropIfExists('social_accounts');
    }
};
