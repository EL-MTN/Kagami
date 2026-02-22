import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
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
  transport:
    config.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
