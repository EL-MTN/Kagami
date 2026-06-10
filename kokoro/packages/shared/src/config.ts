import "dotenv/config";
import { envSpec, mcpServerSchema, type Config, type McpServerConfig } from "./env";

export { mcpServerSchema };
export type { Config, McpServerConfig };

// Module-scope parse, exit-on-invalid — the historical contract: the bot and
// the dashboard (transitively, via the @kokoro/db barrel) both import
// `config` eagerly, and a structurally bad env prints every issue and exits
// before anything boots. Cross-field rule groups are deliberately skipped
// here: the dashboard only needs MONGODB_URI and must not enforce bot-only
// pairings. The bot opts into them via validateConfig() below.
export const config: Config = envSpec.parse(process.env, { onInvalid: "exit", cross: "skip" });

/**
 * Validates the cross-field rule groups (provider→key pairings, Kao
 * both-or-neither, BlueBubbles pairings, MCP name uniqueness, …) on top of
 * the structural parse. Call this at app startup for apps that need the full
 * rail (the bot). Apps that only need MONGODB_URI (the dashboard) skip it.
 */
export function validateConfig(): void {
  envSpec.parse(process.env, { onInvalid: "exit" });
}
