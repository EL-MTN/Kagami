import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@mashiro\//],
  banner: {
    // esbuild bundles @mashiro/* packages (raw .ts) into ESM output, but their
    // transitive deps (dotenv, pino, mongoose, mongodb) are CJS and use require().
    // Inject a real require() so those CJS calls work inside the ESM bundle.
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
