import { createLogger } from "@kagami/logger";
import { config } from "./config";

export const logger = createLogger({
  service: "kokoro-bot",
  component: "bot",
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
  formatters: {
    log(bindings) {
      // Strip base64 image data from logs
      if ("imageData" in bindings) {
        return { ...bindings, imageData: "[base64 omitted]" };
      }
      return bindings;
    },
  },
});
