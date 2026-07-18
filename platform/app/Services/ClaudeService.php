<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Thin wrapper around the OpenAI Chat Completions API.
 *
 * The OpenAI API key never leaves the server — the browser extension talks
 * to our own /api endpoints, which call this service.
 */
class ClaudeService
{
    private string $apiKey;

    private string $model;

    private string $baseUrl;

    public function __construct()
    {
        $this->apiKey = (string) config('services.openai.key');
        $this->model = (string) config('services.openai.model');
        $this->baseUrl = rtrim((string) config('services.openai.base_url'), '/');
    }

    /**
     * Send a single-turn message.
     *
     * @return array{text: string, input_tokens: int, output_tokens: int, model: string}
     */
    public function message(string $system, string $prompt, int $maxTokens = 1024): array
    {
        if ($this->apiKey === '') {
            throw new RuntimeException('OPENAI_API_KEY is not set. Add it to platform/.env.');
        }

        $response = Http::withToken($this->apiKey)
            ->timeout(170)
            ->post($this->baseUrl.'/v1/chat/completions', [
                'model' => $this->model,
                'max_completion_tokens' => $maxTokens,
                'messages' => [
                    ['role' => 'system', 'content' => $system],
                    ['role' => 'user', 'content' => $prompt],
                ],
            ]);

        if ($response->failed()) {
            throw new RuntimeException('OpenAI API error ('.$response->status().'): '.$response->body());
        }

        $data = $response->json();

        $text = $data['choices'][0]['message']['content'] ?? '';

        return [
            'text' => trim($text),
            'input_tokens' => (int) ($data['usage']['prompt_tokens'] ?? 0),
            'output_tokens' => (int) ($data['usage']['completion_tokens'] ?? 0),
            'model' => $data['model'] ?? $this->model,
        ];
    }

    /**
     * Ask the model for a set of distinct options, returned as an array of strings.
     *
     * @return array{options: array<int, string>, input_tokens: int, output_tokens: int, model: string}
     */
    public function generateOptions(string $system, string $prompt, int $count = 3, int $maxTokens = 1024): array
    {
        $instruction = $prompt."\n\n"
            ."Return ONLY a JSON object of the exact form {\"options\": [\"...\"]} containing exactly {$count} "
            .'distinct options as strings. Do not include any commentary, keys, or text outside the JSON.';

        $result = $this->message($system, $instruction, $maxTokens);

        return [
            'options' => array_map(
                $this->stripDashes(...),
                $this->parseOptions($result['text'], $count)
            ),
            'input_tokens' => $result['input_tokens'],
            'output_tokens' => $result['output_tokens'],
            'model' => $result['model'],
        ];
    }

    /**
     * Best-effort extraction of the options array from the model's text.
     *
     * @return array<int, string>
     */
    private function parseOptions(string $text, int $count): array
    {
        // Strip markdown code fences the model sometimes adds.
        $clean = trim(preg_replace('/```(?:json)?/i', '', $text) ?? $text);

        if (preg_match('/\{.*\}/s', $clean, $matches)) {
            $decoded = json_decode($matches[0], true);

            if (is_array($decoded) && isset($decoded['options']) && is_array($decoded['options'])) {
                $options = array_values(array_filter(array_map(
                    static fn ($option) => is_string($option) ? trim($option) : null,
                    $decoded['options']
                )));

                if ($options !== []) {
                    return array_slice($options, 0, $count);
                }
            }
        }

        // Fallback: hand back whatever text we got as a single option so the
        // user still gets something usable rather than an error.
        return $clean === '' ? [] : [$clean];
    }

    /**
     * Belt-and-suspenders: strip em/en-dashes even if the model ignores the
     * prompt instruction against using them.
     */
    private function stripDashes(string $text): string
    {
        return trim(preg_replace('/\s*[—–]\s*/u', ', ', $text) ?? $text);
    }
}
