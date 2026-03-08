import fs from "node:fs/promises";
import path from "node:path";

const VAULT_PATH = "./apps/bot/vault";

const structure = ["personality"];

async function seed() {
  for (const dir of structure) {
    await fs.mkdir(path.join(VAULT_PATH, dir), { recursive: true });
  }

  console.log("Vault directory structure created.");
  console.log("Personality card and templates should already exist in vault/");
}

seed().catch(console.error);
