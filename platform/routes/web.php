<?php

use App\Http\Controllers\ConnectExtensionController;
use App\Http\Controllers\ConnectXController;
use App\Http\Controllers\HistoryController;
use App\Http\Controllers\ScheduleController;
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
    Route::put('schedule/posts/{post}', [ScheduleController::class, 'update'])->name('schedule.update');
    Route::post('schedule/posts/{post}/regenerate', [ScheduleController::class, 'regenerate'])->name('schedule.regenerate');
    Route::delete('schedule/posts/{post}', [ScheduleController::class, 'destroy'])->name('schedule.destroy');
    Route::post('schedule/posts/{post}/schedule', [ScheduleController::class, 'schedule'])->name('schedule.schedule');
    Route::post('schedule/posts/{post}/unschedule', [ScheduleController::class, 'unschedule'])->name('schedule.unschedule');
    Route::post('schedule/schedule-all', [ScheduleController::class, 'scheduleAll'])->name('schedule.schedule-all');

    // Connect the Chrome extension (Sanctum tokens).
    Route::get('connect', [ConnectExtensionController::class, 'show'])->name('connect.show');
    Route::post('connect/token', [ConnectExtensionController::class, 'store'])->name('connect.store');
    Route::delete('connect/token/{token}', [ConnectExtensionController::class, 'destroy'])->name('connect.destroy');

    // Connect an X (Twitter) account for automatic scheduled-post publishing.
    Route::get('connect/x/redirect', [ConnectXController::class, 'redirect'])->name('connect.x.redirect');
    Route::get('connect/x/callback', [ConnectXController::class, 'callback'])->name('connect.x.callback');
    Route::delete('connect/x', [ConnectXController::class, 'destroy'])->name('connect.x.destroy');
});

require __DIR__.'/settings.php';
