// SPDX-FileCopyrightText: 2026 vietnd69
// SPDX-License-Identifier: MIT
'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const jsdoc = require('eslint-plugin-jsdoc');

module.exports = [
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions }
    },
    rules: {
      strict: ['error', 'function'],
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-globals': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/core.js', 'src/settings.js'],
    languageOptions: { globals: { module: 'readonly' } }
  },
  {
    // README promises JSDoc on every function in shipped code.
    files: ['src/**/*.js', 'popup/**/*.js'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': ['error', { require: { FunctionDeclaration: true } }],
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: ['file', 'enum'] }],
      // The @file header sits on each module's IIFE; it is not that function's doc.
      'jsdoc/require-param': ['error', { exemptedBy: ['inheritdoc', 'file'] }],
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-returns-type': 'error'
    }
  },
  {
    files: ['test/**/*.js', 'tools/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { strict: ['error', 'global'] }
  }
];
