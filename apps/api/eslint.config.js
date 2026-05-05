import tseslint from 'typescript-eslint';
import baseConfig from '@kizuna/eslint-config/base';

export default tseslint.config(
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Tests and scripts assert on JSON.parse'd response bodies and implement
    // async fakes — the strict no-unsafe-* / require-await rules add noise
    // without real safety wins here.
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
