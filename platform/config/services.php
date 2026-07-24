<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Resend, Postmark, AWS, and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    'openai' => [
        'key' => env('OPENAI_API_KEY'),
        'model' => env('OPENAI_MODEL', 'gpt-4o'),
        'base_url' => env('OPENAI_BASE_URL', 'https://api.openai.com'),
    ],

    // X (Twitter) OAuth2 — used by ConnectXController and XPostingService to
    // publish scheduled posts on the user's behalf.
    'x' => [
        'client_id' => env('X_CLIENT_ID'),
        'client_secret' => env('X_CLIENT_SECRET'),
        'redirect_uri' => env('X_REDIRECT_URI'),
    ],

    // LinkedIn OAuth2 — used by ConnectLinkedInController and
    // LinkedInPostingService to publish scheduled posts on the user's behalf.
    // `version` is the LinkedIn-Version header the versioned REST API requires.
    'linkedin' => [
        'client_id' => env('LINKEDIN_CLIENT_ID'),
        'client_secret' => env('LINKEDIN_CLIENT_SECRET'),
        'redirect_uri' => env('LINKEDIN_REDIRECT_URI'),
        'version' => env('LINKEDIN_API_VERSION', '202506'),

        // Posting as a company page requires LinkedIn's Community Management
        // API product, which LinkedIn refuses to provision on an app that
        // holds any other product ("requires that it be the only product on
        // the application"). So pages need a SECOND LinkedIn app, with its
        // own credentials — configure them here to enable the pages flow
        // (see ConnectLinkedInPagesController). Leave the client id empty to
        // turn page support off entirely.
        'pages' => [
            'client_id' => env('LINKEDIN_PAGES_CLIENT_ID'),
            'client_secret' => env('LINKEDIN_PAGES_CLIENT_SECRET'),
            'redirect_uri' => env('LINKEDIN_PAGES_REDIRECT_URI'),
            // Must match what the pages app's Auth tab actually lists —
            // requesting an ungranted scope fails with invalid_scope_error.
            'scopes' => env('LINKEDIN_PAGES_SCOPES', 'w_organization_social rw_organization_admin'),
        ],
    ],

];
