import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The defence against a widened SDK union failing open. Plan §5.4:
      // a `switch (abiSource)` written against three members must not silently
      // fall through when a fourth arrives.
      // Compile-time exhaustiveness, with the defensive runtime default kept.
      // TypeScript sees these switches as exhaustive *today*; the `never`
      // default is what catches an SDK union that widens tomorrow — which has
      // already happened once (AbiSource gained `heuristic` in 0.5.0).
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    // The Io layer is the only place allowed to write to stdout/stderr.
    files: ['src/render/io.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // CommandSpec.run/plan/commit are declared to return a Promise, so `async`
    // is the correct spelling even where a particular command has nothing to
    // await. Forcing `Promise.resolve` wrappers would be noise, not safety.
    files: ['src/commands/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },
);
