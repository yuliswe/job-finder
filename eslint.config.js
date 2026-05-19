import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import jestPlugin from 'eslint-plugin-jest';
import localRulesPlugin from 'eslint-plugin-local-rules';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactNativePlugin from 'eslint-plugin-react-native';
import testingLibraryPlugin from 'eslint-plugin-testing-library';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import local rules
const localRules = (await import('./eslint-local-rules.cjs')).default;

export default [
  // Base configuration for all files
  {
    ignores: [
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      '**/dist/**',
      '**/node_modules/**',
      '**/build/**',
      '**/.aws-sam/**',
      '**/__generated__/**',
    ],
  },

  // Base configuration for TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        tsconfigRootDir: __dirname,
        project: true,
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'local-rules': localRulesPlugin,
      import: importPlugin,
      jest: jestPlugin,
      react: reactPlugin,
      'react-native': reactNativePlugin,
      'react-hooks': reactHooksPlugin,
      'testing-library': testingLibraryPlugin,
      'unused-imports': unusedImportsPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: { project: join(__dirname, 'tsconfig.json') },
        node: true,
      },
      react: {
        version: 'detect',
      },
    },
    rules: {
      // Local rules
      'local-rules/collapse-single-object-argument': 'warn',
      'local-rules/sort-function-argument-props': 'warn',

      // TypeScript rules (keeping only the compatible ones)
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],

      // Unused imports (using the correct rule name for latest version)
      'unused-imports/no-unused-imports': 'error',

      // General rules
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'require-yield': 'off',
      'prefer-const': 'error',
      'prefer-destructuring': [
        'error',
        {
          VariableDeclarator: { object: true, array: false },
          AssignmentExpression: { object: true, array: false },
        },
      ],
      'object-shorthand': ['error', 'properties'],
      'no-useless-rename': 'error',

      // Blank line enforcement
      'padding-line-between-statements': [
        'error',
        // Blank line after the import block
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },

        // Blank line around function declarations
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'function', next: '*' },

        // Blank line after a closing block (if/for/while/try/switch)
        { blankLine: 'always', prev: 'block-like', next: '*' },

        // Blank line after multi-line const/let
        {
          blankLine: 'always',
          prev: ['multiline-const', 'multiline-let'],
          next: '*',
        },

        // Blank line before multi-line expressions
        { blankLine: 'always', prev: '*', next: 'multiline-expression' },
      ],

      // Restricted globals
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Do not use fetch directly. Use the fetchWithTimeout helper instead.',
        },
      ],

      // Restricted imports
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:test'],
              message: 'Please use @jest/global instead.',
            },
            {
              importNames: ['graphql'],
              group: ['graphql'],
              message: 'Please use @/typed-graphql.',
            },
            {
              importNames: ['RequestContext'],
              group: ['node-fetch'],
              message: 'Did you mean to import it from @/RequestContext?',
            },
            {
              group: [
                '@/lambdaHandler',
                '**/lambdaHandler',
                '@/sqsHandler',
                '**/sqsHandler',
              ],
              message: 'Do not import the entrypoint module.',
            },
            {
              importNames: ['Animated'],
              group: ['react-native'],
              message:
                'Do not import Animated from react-native. Use react-native-reanimated instead.',
            },
            {
              importNames: ['SafeAreaView'],
              group: ['react-native'],
              message:
                'Do not import SafeAreaView from "react-native". Import from "react-native-safe-area-context" instead.',
            },
            {
              importNames: ['FlatList'],
              group: ['react-native'],
              message:
                'Do not import FlatList from react-native. Use src/components/react-wrappers/FlatList.tsx instead.',
            },
            {
              importNames: ['ScrollView'],
              group: ['react-native'],
              message:
                'Do not import ScrollView from react-native. Use src/components/react-wrappers/ScrollView.tsx instead.',
            },
            {
              group: ['./*', '../*'],
              message:
                'Do not use relative imports. Use absolute imports instead.',
            },
          ],
          paths: [
            {
              name: 'path',
              message:
                "Use 'node:path' instead of 'path' for Node.js built-ins.",
            },
            {
              name: 'fs',
              message: "Use 'node:fs' instead of 'fs' for Node.js built-ins.",
            },
            {
              name: 'os',
              message: "Use 'node:os' instead of 'os' for Node.js built-ins.",
            },
            {
              name: 'crypto',
              message:
                "Use 'node:crypto' instead of 'crypto' for Node.js built-ins.",
            },
            {
              name: 'process',
              message:
                "Use 'node:process' instead of 'process' for Node.js built-ins.",
            },
            {
              name: 'url',
              message: "Use 'node:url' instead of 'url' for Node.js built-ins.",
            },
            {
              name: 'child_process',
              message:
                "Use 'node:child_process' instead of 'child_process' for Node.js built-ins.",
            },
            {
              name: 'stream',
              message:
                "Use 'node:stream' instead of 'stream' for Node.js built-ins.",
            },
            {
              name: 'util',
              message:
                "Use 'node:util' instead of 'util' for Node.js built-ins.",
            },
            {
              name: 'events',
              message:
                "Use 'node:events' instead of 'events' for Node.js built-ins.",
            },
            {
              name: 'http',
              message:
                "Use 'node:http' instead of 'http' for Node.js built-ins.",
            },
            {
              name: 'https',
              message:
                "Use 'node:https' instead of 'https' for Node.js built-ins.",
            },
            {
              name: 'zlib',
              message:
                "Use 'node:zlib' instead of 'zlib' for Node.js built-ins.",
            },
            {
              name: 'buffer',
              message:
                "Use 'node:buffer' instead of 'buffer' for Node.js built-ins.",
            },
            {
              name: 'timers',
              message:
                "Use 'node:timers' instead of 'timers' for Node.js built-ins.",
            },
          ],
        },
      ],

      // Restricted syntax
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
          message:
            'Usage of sql.raw is not allowed. The input is not checked or escaped by Kysely in any way.',
        },
        {
          selector:
            "CallExpression[callee.object.name='sql'][callee.property.name='id']",
          message:
            'Usage of sql.id is not allowed. The input is not checked or escaped by Kysely in any way.',
        },
        {
          selector:
            "CallExpression[callee.object.name='sql'][callee.property.name='lit']",
          message:
            'Usage of sql.lit is not allowed. The input is not checked or escaped by Kysely in any way.',
        },
        {
          selector:
            "CallExpression[callee.object.name='sql'][callee.property.name='literal']",
          message:
            'Usage of sql.literal is not allowed. The input is not checked or escaped by Kysely in any way.',
        },
        {
          selector:
            "CallExpression[callee.object.name='sql'][callee.property.name='ref']",
          message:
            'Usage of sql.ref is not allowed. The input is not checked or escaped by Kysely in any way.',
        },
        {
          selector:
            "CallExpression[callee.object.name='sql'][callee.property.name='table']",
          message:
            'Usage of sql.table is not allowed. The input is not checked or escaped by Kysely in any way.',
        },
        {
          selector: "CallExpression[callee.name='expect']",
          message: 'Function expressions are not allowed in source files.',
        },
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name='log']",
          message: 'Reminder: remove console.log.',
        },
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Do not read process.env directly. Use `Env` from src/utils/env.js instead.',
        },
        {
          selector:
            "CallExpression[callee.object.name='router'][callee.property.name='back']",
          message:
            'Do not use router.back(). Use `routerDismissTo` or `routerBackOrDismissTo` instead.',
        },
      ],

      // React Native rules
      'react-native/no-raw-text': [
        'error',
        {
          skip: [
            'ThemePurpleButton',
            'ThemeOutlineButton',
            'ThemeLinkButton',
            'ThemeBlackButton',
            'ScreenTitle',
            'ScreenTitle2',
            'SmallThemePurpleButton',
            'SmallThemeWhiteButton',
            'Heading1',
            'Heading2',
            'Heading3',
            'Heading4',
            'Heading5',
          ],
        },
      ],

      // Quotes
      quotes: ['error', 'single', { avoidEscape: true }],

      // Import rules
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'import/no-relative-packages': 'error',
      'import/no-unused-modules': [
        'warn',
        {
          unusedExports: true,
          missingExports: false,
          ignoreUnusedTypeExports: false,
        },
      ],
      'import/no-named-as-default-member': 'off',
    },
  },

  // Env loader is the only allowed reader of process.env
  {
    files: ['src/utils/env.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Test files configuration
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'jest/no-restricted-matchers': [
        'error',
        {
          toMatchSnapshot:
            'Use toMatchInlineSnapshot instead of toMatchSnapshot.',
          toThrowErrorMatchingSnapshot:
            'Use toThrowErrorMatchingInlineSnapshot instead of toThrowErrorMatchingSnapshot.',
        },
      ],
    },
  },

  // Migration files configuration
  {
    files: ['**/migrations/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'import/no-unused-modules': 'off',
    },
  },

  // Testing library configuration (simplified)
  {
    files: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
    plugins: {
      'testing-library': testingLibraryPlugin,
    },
  },

  // Tests directory configuration
  {
    files: ['**/tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
];
