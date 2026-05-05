import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/api/src/paths.ts → apps/api/
export const appRoot = path.resolve(__dirname, "..");

export const paths = {
  prompts: path.join(appRoot, "prompts"),
} as const;
