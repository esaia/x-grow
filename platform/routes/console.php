<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Auto-publish Scheduled posts to X once their time arrives. In production
// this requires a system cron entry running `php artisan schedule:run` every
// minute; locally it's driven by `schedule:work` (see AppServiceProvider).
Schedule::command('schedule:publish-due-posts')->everyMinute()->withoutOverlapping();
