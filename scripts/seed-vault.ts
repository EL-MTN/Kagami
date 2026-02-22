import fs from "node:fs/promises";
import path from "node:path";

const VAULT_PATH = "./vault";

const structure = [
  "personality",
  "memories",
  "memories/conversations",
  "calendar",
];

async function seed() {
  for (const dir of structure) {
    await fs.mkdir(path.join(VAULT_PATH, dir), { recursive: true });
  }

  console.log("Vault directory structure created.");
  console.log("Personality card and templates should already exist in vault/");
}

seed().catch(console.error);
