import esbuild from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const externalizeNonMashiro: esbuild.Plugin = {
  name: "externalize-non-mashiro",
  setup(build) {
    // Externalize all bare imports except @mashiro/* packages
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@mashiro/")) return undefined;
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
  plugins: [externalizeNonMashiro],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
