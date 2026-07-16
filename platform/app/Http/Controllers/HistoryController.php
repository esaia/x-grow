<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class HistoryController extends Controller
{
    /**
     * List the user's past generations (replies and posts).
     */
    public function index(Request $request): Response
    {
        $generations = $request->user()->generations()
            ->latest()
            ->paginate(20)
            ->through(fn ($g) => [
                'id' => $g->id,
                'type' => $g->type,
                'input_context' => $g->input_context,
                'meta' => $g->meta,
                'output' => $g->output,
                'model' => $g->model,
                'created_at' => $g->created_at?->toDayDateTimeString(),
            ]);

        return Inertia::render('history', [
            'generations' => $generations,
        ]);
    }
}
