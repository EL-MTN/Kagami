// Group staged files by their containing workspace package and lint each
// package's source tree as a whole. Type-aware ESLint rules need the full
// TypeScript program to resolve cross-file types — running `eslint --fix` on a
// single staged file leaves heavily-generic imports (e.g. `tool` from `ai`)
// unresolved and trips `@typescript-eslint/no-unsafe-*` on otherwise fine code.

const PACKAGE_REGEX = /^(apps|packages)\/[^/]+/;

function packagesFromFiles(files) {
  const set = new Set();
  for (const f of files) {
    const m = f.match(PACKAGE_REGEX);
    if (m) set.add(m[0]);
  }
  return [...set];
}

export default {
  "**/*.{ts,tsx}": (files) => {
    const packages = packagesFromFiles(files);
    if (packages.length === 0) return [];
    const eslintCmds = packages.map((pkg) => `eslint --fix ${pkg}/src`);
    return [...eslintCmds, `prettier --write ${files.join(" ")}`];
  },
  "**/*.{json,md}": (files) => [`prettier --write ${files.join(" ")}`],
};
