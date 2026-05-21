#!/usr/bin/env node
// Doc-reference rot scanner.
//
// Walks every .md file under a project root, extracts file-path and
// identifier references, and reports the ones that no longer resolve in
// the codebase. Output is JSON on stdout so a subagent can consume it.
//
// Usage:
//   node .claude/skills/cleanup/scripts/doc-scan.mjs <projectRoot> [--repo-root <path>]
//
// File refs (HIGH confidence): paths inside backticks or markdown links
// that look like real fs paths (contain a slash, or end in a known
// source extension). A miss is reported as a broken-file finding.
//
// Symbol refs (MEDIUM confidence): backticked identifiers that look like
// code symbols (CamelCase, camelCase, snake_case with letters). A miss
// is reported only if no `export|class|function|const|let|var|type|interface`
// declaration of that name exists anywhere under repoRoot.
//
// Allowlist patterns reduce noise — extend EXCLUDE_SYMBOLS / EXCLUDE_PATHS
// as needed.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('usage: doc-scan.mjs <projectRoot> [--repo-root <path>]\n');
  process.exit(2);
}

const projectRoot = resolve(args[0]);
const repoRootFlag = args.indexOf('--repo-root');
const repoRoot = repoRootFlag >= 0 ? resolve(args[repoRootFlag + 1]) : resolve(projectRoot, '..');

// ---- collect targets ---------------------------------------------------

const MD_DIRS = ['', 'docs'];
const EXTRA_FILES = ['CLAUDE.md', 'README.md', 'ARCHITECTURE.md'];

async function listMarkdown(root) {
  const out = [];
  for (const sub of MD_DIRS) {
    const dir = sub ? join(root, sub) : root;
    if (!existsSync(dir)) continue;
    if (sub === '') {
      for (const f of EXTRA_FILES) {
        const p = join(dir, f);
        if (existsSync(p) && statSync(p).isFile()) out.push(p);
      }
      continue;
    }
    await walk(dir, out);
  }
  return out;
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    }
  }
}

// ---- extractors --------------------------------------------------------

const BACKTICK = /`([^`\n]{1,200})`/g;
const MD_LINK = /\[[^\]]+\]\(([^)\s#?]+)(?:[)\s#?])/g;

const PATH_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md|sh|yml|yaml)$/;
// Conservative: only call something a file path if it ends with a known
// source extension. Bare paths like `apps/dashboard` or URL routes like
// `/oauth/*` are too ambiguous to flag.
const LOOKS_LIKE_PATH = (s) => {
  if (!PATH_EXT.test(s)) return false;
  if (s.startsWith('/')) return false; // URL route, not a file path
  if (s.includes('*') || s.includes(':')) return false; // wildcard / template
  if (s.startsWith('.') && !s.startsWith('./') && !s.startsWith('../')) return false; // bare extension like `.env`
  return true;
};

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LOOKS_LIKE_SYMBOL = (s) =>
  IDENT.test(s) &&
  s.length >= 4 &&
  // require some shape: CamelCase, camelCase, or snake_case with a letter mix
  ((/[A-Z]/.test(s) && /[a-z]/.test(s)) || (s.includes('_') && /[a-zA-Z]/.test(s)));

const EXCLUDE_SYMBOLS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'TODO',
  'FIXME',
  'NOTE',
  'CLAUDE',
  'README',
  'NaN',
]);

const EXCLUDE_PATH_PREFIXES = [
  'http://',
  'https://',
  'mailto:',
  '#',
  '<',
  '$',
  '@', // npm scoped pkg name, not a path
];

function extract(content) {
  const fileRefs = new Set();
  const symbolRefs = new Set();

  for (const m of content.matchAll(BACKTICK)) {
    const raw = m[1].trim();
    if (!raw) continue;
    if (EXCLUDE_PATH_PREFIXES.some((p) => raw.startsWith(p))) continue;
    // strip trailing punctuation
    const cleaned = raw.replace(/[),.:;]+$/, '');
    if (LOOKS_LIKE_PATH(cleaned) && !cleaned.includes(' ')) {
      fileRefs.add(cleaned);
    } else if (LOOKS_LIKE_SYMBOL(cleaned) && !EXCLUDE_SYMBOLS.has(cleaned)) {
      symbolRefs.add(cleaned);
    }
  }

  for (const m of content.matchAll(MD_LINK)) {
    const raw = m[1].trim();
    if (EXCLUDE_PATH_PREFIXES.some((p) => raw.startsWith(p))) continue;
    fileRefs.add(raw);
  }

  return { fileRefs, symbolRefs };
}

// ---- verifiers ---------------------------------------------------------

// Lazily-built index of every file path under projectRoot + repoRoot,
// stored as the path relative to repoRoot. We match a doc reference if
// any indexed path ends with `/<ref>` or equals `<ref>` — this lets docs
// use shorthand like `src/main.ts` without naming the full subdir chain.
let fileIndex = null;
function loadFileIndex() {
  if (fileIndex) return fileIndex;
  fileIndex = [];
  const queue = [repoRoot];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (
        e.name === 'node_modules' ||
        e.name === '.git' ||
        e.name === 'dist' ||
        e.name === '.next' ||
        e.name === '.turbo' ||
        e.name === 'coverage'
      )
        continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(p);
      } else if (e.isFile()) {
        fileIndex.push(relative(repoRoot, p));
      }
    }
  }
  return fileIndex;
}

function resolveFileRef(ref, mdFilePath) {
  // 1. relative to the markdown file's directory
  const fromMd = resolve(mdFilePath, '..', ref);
  if (existsSync(fromMd)) return fromMd;
  // 2. relative to the project root being scanned
  const fromProject = resolve(projectRoot, ref);
  if (existsSync(fromProject)) return fromProject;
  // 3. relative to the repo root
  const fromRepo = resolve(repoRoot, ref);
  if (existsSync(fromRepo)) return fromRepo;
  // 4. anywhere under repoRoot (handles relative shorthand like `src/main.ts`)
  loadFileIndex();
  const needle = '/' + ref;
  for (const indexed of fileIndex) {
    if (indexed === ref || indexed.endsWith(needle)) return indexed;
  }
  return null;
}

// Build a lazy index of every identifier-like token that appears in any
// source file. A doc symbol is considered "live" if it appears anywhere
// in the codebase — declared, used, as an object key, in a string
// literal, anything. This is intentionally permissive: the goal is to
// catch *outright drift* (symbol no longer exists at all), not lint-grade
// dead-export detection (knip handles that).
let symbolIndex = null;
function loadSymbolIndex() {
  if (symbolIndex) return symbolIndex;
  symbolIndex = new Set();
  const tokenRe = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
  const queue = [repoRoot];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (
        e.name === 'node_modules' ||
        e.name === '.git' ||
        e.name === 'dist' ||
        e.name === '.next' ||
        e.name === '.turbo' ||
        e.name === 'coverage'
      )
        continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(p);
      } else if (e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(e.name)) {
        let src;
        try {
          src = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        for (const m of src.matchAll(tokenRe)) {
          symbolIndex.add(m[0]);
        }
      }
    }
  }
  return symbolIndex;
}

// ---- run ---------------------------------------------------------------

const mdFiles = await listMarkdown(projectRoot);
const brokenFiles = [];
const brokenSymbols = [];

let symIndexLoaded = false;

for (const mdPath of mdFiles) {
  let content;
  try {
    content = readFileSync(mdPath, 'utf8');
  } catch {
    continue;
  }
  const { fileRefs, symbolRefs } = extract(content);

  for (const ref of fileRefs) {
    if (!resolveFileRef(ref, mdPath)) {
      brokenFiles.push({ doc: relative(repoRoot, mdPath), ref });
    }
  }

  if (symbolRefs.size > 0 && !symIndexLoaded) {
    loadSymbolIndex();
    symIndexLoaded = true;
  }
  for (const sym of symbolRefs) {
    if (symbolIndex && !symbolIndex.has(sym)) {
      brokenSymbols.push({ doc: relative(repoRoot, mdPath), symbol: sym });
    }
  }
}

process.stdout.write(
  JSON.stringify(
    {
      projectRoot: relative(repoRoot, projectRoot) || '.',
      mdFilesScanned: mdFiles.length,
      brokenFiles,
      brokenSymbols,
    },
    null,
    2,
  ) + '\n',
);
