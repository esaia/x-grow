<?php

namespace App\Http\Requests;

use App\Services\PromptBuilder;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class GeneratePostRequest extends FormRequest
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
            'topic' => ['required', 'string', 'max:5000'],
            'format' => ['nullable', 'string', Rule::in(PromptBuilder::POST_FORMATS)],
            'tone' => ['nullable', 'string', Rule::in(PromptBuilder::TONES)],
            'count' => ['nullable', 'integer', 'min:1', 'max:5'],
        ];
    }
}
