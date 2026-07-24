<?php

use App\Http\Controllers\Api\AccountController;
use App\Http\Controllers\Api\GenerationController;
use App\Http\Controllers\Api\InspirationIngestController;
use App\Http\Controllers\Api\VoiceProfileController;
use Illuminate\Support\Facades\Route;

/*
 * All routes here are consumed by the Chrome extension using a Sanctum
 * personal access token (Authorization: Bearer <token>).
 */
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/me', [AccountController::class, 'me']);

    Route::get('/voice-profile', [VoiceProfileController::class, 'show']);
    Route::put('/voice-profile', [VoiceProfileController::class, 'update']);
    Route::post('/voice/learn', [VoiceProfileController::class, 'learn']);

    Route::post('/generate/reply', [GenerationController::class, 'reply']);
    Route::post('/generate/post', [GenerationController::class, 'post']);
    Route::post('/generate/recent', [GenerationController::class, 'recent']);

    // Posts the extension scraped off a creator's x.com profile.
    Route::get('/inspiration/creators', [InspirationIngestController::class, 'creators']);
    Route::post('/inspiration/ingest', [InspirationIngestController::class, 'store']);
});
