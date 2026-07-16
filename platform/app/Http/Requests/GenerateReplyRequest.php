<?php

namespace App\Http\Requests;

use App\Services\PromptBuilder;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class GenerateReplyRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'tweet' => ['required', 'string', 'max:5000'],
            'thread_context' => ['nullable', 'string', 'max:10000'],
            'tone' => ['nullable', 'string', Rule::in(PromptBuilder::TONES)],
            'count' => ['nullable', 'integer', 'min:1', 'max:5'],
        ];
    }
}
