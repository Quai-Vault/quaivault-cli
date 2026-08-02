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
    // Plan §1/§5.2: the TUI can do nothing the one-shot surface cannot, and
    // that rule is worth nothing as a convention. `tui/` holds the pure
    // reducer and the spawned-signer boundary; it goes through the
    // dispatcher and `format/` for everything else.
    //
    // `allowTypeImports` is the meaningful line. A type import erases at
    // build time and cannot call anything, so `import type { Affordance }`
    // is the reducer describing the shape it reduces over. A *value* import
    // would let the TUI reach the chain directly, and then "signs by
    // delegation" becomes something you have to check by reading rather
    // than something the build enforces.
    files: ['src/tui/**/*.ts', 'src/tui/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@quaivault/sdk',
              allowTypeImports: true,
              message:
                'tui/ must not call the SDK. Route through the dispatcher; the TUI signs by spawning a one-shot process (§4.4). Type-only imports are fine.',
            },
            {
              name: 'quais',
              allowTypeImports: true,
              message:
                'tui/ must never touch key material or a provider. The spawned signer owns that (§4.4).',
            },
          ],
          patterns: [
            {
              group: ['**/commands/*', '../commands/*'],
              allowTypeImports: true,
              message:
                'tui/ must not reach into a command implementation. Go through the dispatcher so the TUI cannot acquire a capability the one-shot surface lacks.',
            },
            {
              group: ['**/keys/*', '../keys/*'],
              message:
                'The TUI holds no key. kill -USR1 on a long-lived process is a full heap read, which is the entire reason for the spawned-signer design (§4.4).',
            },
            {
              group: ['**/abi/*', '../abi/*'],
              allowTypeImports: true,
              message:
                'tui/ projects data; it does not decode calldata. Compute the batch analysis in commands/ and hand it in, so a component cannot re-derive what a reviewer is about to sign. Type-only imports are fine.',
            },
          ],
        },
      ],
    },
  },
  {
    // CommandSpec.run/plan/commit are declared to return a Promise, so `async`
    // is the correct spelling even where a particular command has nothing to
    // await. Forcing `Promise.resolve` wrappers would be noise, not safety.
    files: ['src/commands/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Plain .mjs tooling. It is not typechecked, so `no-undef` is the only
    // thing standing between a deleted variable and a run that does forty
    // minutes of chain work and then dies on the final write — which is
    // exactly what happened to `now` in fixture-vault.mjs.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Opt out of the type-aware parser: these files are not in tsconfig and
      // do not need to be. `no-undef` is a syntactic rule and is the point.
      parserOptions: { projectService: false, project: false },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-undef': 'error',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
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
