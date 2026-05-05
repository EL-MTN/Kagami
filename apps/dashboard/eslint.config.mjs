import tseslint from 'typescript-eslint';
import nextConfig from '@kizuna/eslint-config/next';

export default tseslint.config(
  ...nextConfig,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
