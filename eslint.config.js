import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'extensions/**/dist/**',
      // Browser-side panel assets are transpiled in-browser (CDN React + Babel),
      // not part of the Node/TS build — they use browser globals ESLint's
      // Node config doesn't know about.
      'extensions/**/web/**',
      // Vendored, pre-minified third-party bundles (React/ReactDOM/Babel/marked).
      // Not our source; linting them is pure noise.
      'src/panel/web/vendor/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Browser-side panel JSX. Transpiled in-browser by the vendored Babel against
    // a global (window.React) React — there is no bundler and React is never
    // imported, so react-in-jsx-scope is off and React/ReactDOM/marked/Babel are
    // declared globals. jsx-uses-vars teaches no-unused-vars that a component
    // referenced only in JSX is still used; without it every component reads as
    // dead. prop-types stays off — this codebase doesn't use runtime prop checks.
    files: ['src/panel/web/**/*.{js,jsx}'],
    plugins: { react: reactPlugin, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        React: 'readonly',
        ReactDOM: 'readonly',
        Babel: 'readonly',
        marked: 'readonly',
        // Host bridge injected by the embedding webview (see show_widget /
        // panel server) so chat surfaces can post a message as the user.
        sendPrompt: 'readonly',
      },
    },
    settings: { react: { version: '18.0' } },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Hooks discipline is worth enforcing; exhaustive-deps stays advisory
      // (some effects deliberately run once), but registering the plugin also
      // resolves the inline `react-hooks/*` disable directives already in the
      // source.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      // ignoreRestSiblings: a prop destructured purely to keep it out of a
      // `...rest` spread (e.g. `{ fill, ...rest }` so `fill` isn't forwarded to
      // the DOM) is intentionally unused — that's the whole point.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // The TS variant rides in via typescript-eslint's shared config; for these
      // browser files the core rule above is the one we want.
      '@typescript-eslint/no-unused-vars': 'off',
      // The panel JSX leans on the `cond && fn()` / `cond ? a() : b()` guard-call
      // idiom for side effects; allow those while still catching truly dead
      // expression statements.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  prettier,
];
