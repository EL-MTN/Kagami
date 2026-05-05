import esbuild from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const externalizeNonKokoro: esbuild.Plugin = {
  name: "externalize-non-kokoro",
  setup(build) {
    // Externalize all bare imports except @kokoro/* packages
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@kokoro/")) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outdir: "dist",
  sourcemap: true,
  splitting: false,
  plugins: [externalizeNonKokoro],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
