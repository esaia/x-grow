<?php

namespace App\Providers;

use Carbon\CarbonImmutable;
use Illuminate\Foundation\DevCommands;
use Illuminate\Support\Facades\Date;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        $this->configureDefaults();

        // Serve `composer run dev` on port 8001 instead of the default 8000.
        // Re-registering the "server" dev command from app code overrides the
        // framework default (userland priority beats the built-in).
        if ($this->app->runningInConsole()) {
            DevCommands::artisan('serve --host=localhost --port=8001', 'server');

            // Drives the per-minute schedule:publish-due-posts run (see
            // routes/console.php) so scheduled posts auto-publish in local dev.
            DevCommands::artisan('schedule:work', 'schedule');
        }
    }

    /**
     * Configure default behaviors for production-ready applications.
     */
    protected function configureDefaults(): void
    {
        Date::use(CarbonImmutable::class);

        DB::prohibitDestructiveCommands(
            app()->isProduction(),
        );

        Password::defaults(fn (): ?Password => app()->isProduction()
            ? Password::min(12)
                ->mixedCase()
                ->letters()
                ->numbers()
                ->symbols()
                ->uncompromised()
            : null,
        );
    }
}
