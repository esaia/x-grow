<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Thin wrapper around the Anthropic Messages API.
 *
 * The Anthropic API key never leaves the server — the browser extension talks
 * to our own /api endpoints, which call this service.
 */
class ClaudeService
{
    private string $apiKey;

    private string $model;

    private string $baseUrl;

    public function __construct()
    {
        $this->apiKey = (string) config('services.anthropic.key');
        $this->model = (string) config('services.anthropic.model');
        $this->baseUrl = rtrim((string) config('services.anthropic.base_url'), '/');
    }

    /**
     * Send a single-turn message.
     *
     * @return array{text: string, input_tokens: int, output_tokens: int, model: string}
     */
    public function message(string $system, string $prompt, int $maxTokens = 1024, float $temperature = 1.0): array
    {
        if ($this->apiKey === '') {
            throw new RuntimeException('ANTHROPIC_API_KEY is not set. Add it to platform/.env.');
        }

        $response = Http::withHeaders([
            'x-api-key' => $this->apiKey,
            'anthropic-version' => '2023-06-01',
            'content-type' => 'application/json',
        ])
            ->timeout(60)
            ->post($this->baseUrl.'/v1/messages', [
                'model' => $this->model,
                'max_tokens' => $maxTokens,
                'temperature' => $temperature,
                'system' => $system,
                'messages' => [
                    ['role' => 'user', 'content' => $prompt],
                ],
            ]);

        if ($response->failed()) {
            throw new RuntimeException('Claude API error ('.$response->status().'): '.$response->body());
        }

        $data = $response->json();

        $text = collect($data['content'] ?? [])
            ->where('type', 'text')
            ->pluck('text')
            ->implode('');

        return [
            'text' => trim($text),
            'input_tokens' => (int) ($data['usage']['input_tokens'] ?? 0),
            'output_tokens' => (int) ($data['usage']['output_tokens'] ?? 0),
            'model' => $data['model'] ?? $this->model,
        ];
    }

    /**
     * Ask Claude for a set of distinct options, returned as an array of strings.
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
            'options' => $this->parseOptions($result['text'], $count),
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
}
