// Flat ESLint config. Catches real bugs (undeclared globals, unused vars,
// unreachable code, duplicate keys) that `node --test` can't see. Style is
// kept to warnings so the lint is adoptable without a big reformat.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'vendor/**',
      'public/**',
      'data/**',
      '.vercel/**',
      '.venv/**', // Python virtualenv ships bundled third-party JS
      '.claude/**',
      '**/site-packages/**',
      '**/.hyperframes/**',
      '**/renders/**',
      'brag-output*/**',
      'demo-video/**',
      '**/*.min.js',
      '**/*.ts', // no TypeScript parser wired up; hello.ts / neon.ts are out of scope
    ],
  },

  js.configs.recommended,

  // Shared language options + rule posture for every linted file.
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },

  // Node backend, scripts, serverless entry, and tests.
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'api/**/*.mjs', '**/*.test.mjs', '*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Browser surfaces. app.js/console.js are ES modules; the rest are classic
  // <script> tags. Leaflet is loaded globally as `L`. core.js is isomorphic
  // (also imported by core.test.mjs) and references no environment globals.
  {
    files: ['app.js', 'console.js', 'explainer.js', 'pitch-deck.js', 'sw-update.js', 'core.js'],
    languageOptions: {
      globals: { ...globals.browser, L: 'readonly' },
    },
  },

  // Service worker: its own global scope (self, clients, caches, skipWaiting…).
  {
    files: ['sw.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
];
