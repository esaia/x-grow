<?php

return [

    /*
     * The Chrome extension calls these paths cross-origin with a Bearer token
     * (no cookies), so a wildcard origin is safe here — there are no
     * credentials to protect via the browser's same-origin policy.
     */

    'paths' => ['api/*'],

    'allowed_methods' => ['*'],

    'allowed_origins' => ['*'],

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['*'],

    'exposed_headers' => [],

    'max_age' => 0,

    'supports_credentials' => false,

];
