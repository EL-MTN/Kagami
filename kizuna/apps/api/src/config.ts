import { config as dotenvConfig } from "dotenv";
import { envSpec, type Config } from "./env.js";

export type { Config };

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  const source = env ?? process.env;
  if (!env) dotenvConfig();
  return envSpec.parse(source);
}
