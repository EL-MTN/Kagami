// Build .memory/entities.jsonl for the vault at $BRAINIAC_VAULT. Reads
// facts.jsonl, replays upsertEntitiesFromFacts, persists. Idempotent:
// wipes any prior entities.jsonl first, then rebuilds from current facts.
//
// Single-vault by design — paths.ts captures BRAINIAC_VAULT at module
// load so iterating multiple vaults in one process is unsafe. Use a shell
// loop to migrate many vaults.
//
// Usage:
//   set -a; . ./.env; set +a;
//   for d in bench/longmemeval/vaults/*/; do
//     BRAINIAC_VAULT="$d" \
//       LMSTUDIO_URL=https://api.openai.com/v1 LMSTUDIO_API_KEY=$OPENAI_API_KEY \
//       EMBEDDING_MODEL=text-embedding-3-small MODEL=gpt-4o-mini \
//       npx tsx scripts/migrate-build-entity-store.ts
//   done

import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../src/paths.ts';
import { readFacts } from '../src/facts.ts';
import { upsertEntitiesFromFacts, writeEntities } from '../src/entities.ts';

async function main() {
  const factsPath = paths.facts;
  try {
    const stat = await fs.stat(factsPath);
    if (!stat.isFile() || stat.size === 0) {
      console.log(JSON.stringify({ vault: paths.vault, skipped: 'empty facts.jsonl' }));
      return;
    }
  } catch {
    console.log(JSON.stringify({ vault: paths.vault, skipped: 'no facts.jsonl' }));
    return;
  }

  // Clean rebuild: drop any prior entity store, then upsert from facts.
  await writeEntities([]);
  const facts = await readFacts();
  const r = await upsertEntitiesFromFacts(facts);
  console.log(
    JSON.stringify({
      vault: path.basename(paths.vault),
      facts: facts.length,
      entities_created: r.created,
      links: r.linked,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
