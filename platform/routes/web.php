<?php

use App\Http\Controllers\ConnectExtensionController;
use App\Http\Controllers\ConnectLinkedInController;
use App\Http\Controllers\ConnectLinkedInPagesController;
use App\Http\Controllers\ConnectXController;
use App\Http\Controllers\HistoryController;
use App\Http\Controllers\InspirationController;
use App\Http\Controllers\ScheduleController;
use App\Http\Controllers\SocialAccountController;
use App\Http\Controllers\VoiceController;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'welcome')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::inertia('dashboard', 'dashboard')->name('dashboard');

    // Voice profile — the writing style the AI mimics.
    Route::get('voice', [VoiceController::class, 'edit'])->name('voice.edit');
    Route::put('voice', [VoiceController::class, 'update'])->name('voice.update');

    // Past generations.
    Route::get('history', [HistoryController::class, 'index'])->name('history.index');

    // Weekly schedule of AI-generated draft posts.
    Route::get('schedule', [ScheduleController::class, 'index'])->name('schedule.index');
    Route::post('schedule/generate', [ScheduleController::class, 'generate'])->name('schedule.generate');
    Route::post('schedule/posts', [ScheduleController::class, 'store'])->name('schedule.store');
    Route::post('schedule/posts/generate-one', [ScheduleController::class, 'generateOne'])->name('schedule.generate-one');
    Route::put('schedule/posts/{post}', [ScheduleController::class, 'update'])->name('schedule.update');
    Route::post('schedule/posts/{post}/regenerate', [ScheduleController::class, 'regenerate'])->name('schedule.regenerate');
    Route::delete('schedule/posts/{post}', [ScheduleController::class, 'destroy'])->name('schedule.destroy');
    Route::post('schedule/posts/{post}/schedule', [ScheduleController::class, 'schedule'])->name('schedule.schedule');
    Route::post('schedule/posts/{post}/unschedule', [ScheduleController::class, 'unschedule'])->name('schedule.unschedule');
    Route::post('schedule/schedule-all', [ScheduleController::class, 'scheduleAll'])->name('schedule.schedule-all');
    Route::post('schedule/empty-week', [ScheduleController::class, 'emptyWeek'])->name('schedule.empty-week');

    // Inspiration — tracked creators and their viral posts.
    Route::get('inspiration', [InspirationController::class, 'index'])->name('inspiration.index');
    Route::post('inspiration/creators', [InspirationController::class, 'storeCreator'])->name('inspiration.creators.store');
    Route::delete('inspiration/creators/{creator}', [InspirationController::class, 'destroyCreator'])->name('inspiration.creators.destroy');
    Route::post('inspiration/posts/{post}/use', [InspirationController::class, 'useIdea'])->name('inspiration.use');
    Route::post('inspiration/publish', [InspirationController::class, 'publish'])->name('inspiration.publish');
    Route::post('inspiration/schedule', [InspirationController::class, 'schedule'])->name('inspiration.schedule');

    // Connect the Chrome extension (Sanctum tokens).
    Route::get('connect', [ConnectExtensionController::class, 'show'])->name('connect.show');
    Route::post('connect/token', [ConnectExtensionController::class, 'store'])->name('connect.store');
    Route::delete('connect/token/{token}', [ConnectExtensionController::class, 'destroy'])->name('connect.destroy');

    // Connect an X (Twitter) account for automatic scheduled-post publishing.
    Route::get('connect/x/redirect', [ConnectXController::class, 'redirect'])->name('connect.x.redirect');
    Route::get('connect/x/callback', [ConnectXController::class, 'callback'])->name('connect.x.callback');

    // Connect a LinkedIn account (and the company pages it administers).
    Route::get('connect/linkedin/redirect', [ConnectLinkedInController::class, 'redirect'])->name('connect.linkedin.redirect');
    Route::get('connect/linkedin/callback', [ConnectLinkedInController::class, 'callback'])->name('connect.linkedin.callback');

    // Company pages need a second LinkedIn app (Community Management API
    // refuses to share an app with the member products), so they get their
    // own handshake against separate credentials.
    Route::get('connect/linkedin/pages/redirect', [ConnectLinkedInPagesController::class, 'redirect'])->name('connect.linkedin.pages.redirect');
    Route::get('connect/linkedin/pages/callback', [ConnectLinkedInPagesController::class, 'callback'])->name('connect.linkedin.pages.callback');

    // Pausing/resuming and disconnecting are uniform across networks.
    Route::put('connect/accounts/{account}', [SocialAccountController::class, 'update'])->name('connect.accounts.update');
    Route::delete('connect/accounts/{account}', [SocialAccountController::class, 'destroy'])->name('connect.accounts.destroy');
});

require __DIR__.'/settings.php';
