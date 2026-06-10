/**
 * Workspace env-artifact generator. For every app in scripts/env/manifest.ts:
 *
 *   - <app>/.env.example                  (full template, doc comments)
 *   - <project>/docs/configuration.md     (table between kagami-env markers)
 *   - <app>/turbo.json                    (per-task env declarations)
 *
 * `--check` reports drift and exits 1 instead of writing (CI / pre-push).
 * Markdown and JSON outputs are piped through prettier with the repo config so
 * lint-staged's prettier pass can never disagree with generated output.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import {
  renderConfigDocTable,
  renderEnvExample,
  renderTurboPackageConfig,
  replaceBetweenMarkers,
} from "@kagami/env";
import { targets } from "./manifest.js";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const check = process.argv.includes("--check");
const drift: string[] = [];

async function formatWith(
  parser: "markdown" | "json",
  relPath: string,
  content: string,
): Promise<string> {
  const options = (await prettier.resolveConfig(path.join(ROOT, relPath))) ?? {};
  return prettier.format(content, { ...options, parser });
}

async function emit(relPath: string, content: string): Promise<void> {
  const abs = path.join(ROOT, relPath);
  const existing = existsSync(abs) ? await readFile(abs, "utf8") : null;
  if (existing === content) return;
  if (check) {
    drift.push(relPath);
    return;
  }
  await writeFile(abs, content);
  console.log(`wrote ${relPath}`);
}

for (const target of targets) {
  const spec = await target.load();

  await emit(`${target.appDir}/.env.example`, renderEnvExample(spec));

  if (target.configDoc) {
    const docAbs = path.join(ROOT, target.configDoc.path);
    const current = await readFile(docAbs, "utf8");
    const replaced = replaceBetweenMarkers(
      current,
      target.configDoc.markerId,
      renderConfigDocTable(spec),
    );
    await emit(
      target.configDoc.path,
      await formatWith("markdown", target.configDoc.path, replaced),
    );
  }

  if (target.turboTasks?.length) {
    const json = JSON.stringify(renderTurboPackageConfig(spec, target.turboTasks), null, 2);
    await emit(
      `${target.appDir}/turbo.json`,
      await formatWith("json", `${target.appDir}/turbo.json`, json),
    );
  }
}

if (check) {
  if (drift.length > 0) {
    console.error("env artifacts out of date (run `npm run env:gen`):");
    for (const relPath of drift) console.error(`  - ${relPath}`);
    process.exit(1);
  }
  console.log("env artifacts up to date");
}
