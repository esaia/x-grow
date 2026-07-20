<?php

namespace App\Http\Requests;

use App\Services\PromptBuilder;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateVoiceProfileRequest extends FormRequest
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
            'tone' => ['nullable', 'string', Rule::in(PromptBuilder::TONES)],
            'sample_posts' => ['nullable', 'string', 'max:10000'],
            'dos' => ['nullable', 'string', 'max:5000'],
            'donts' => ['nullable', 'string', 'max:5000'],
            'bio_context' => ['nullable', 'string', 'max:5000'],
            'facts' => ['nullable', 'string', 'max:5000'],
            'links' => ['nullable', 'string', 'max:2000'],
            'projects' => ['nullable', 'string', 'max:5000'],
            'topics' => ['nullable', 'string', 'max:2000'],
            'news_context' => ['nullable', 'string', 'max:2000'],
            'audience' => ['nullable', 'string', 'max:2000'],
        ];
    }
}
