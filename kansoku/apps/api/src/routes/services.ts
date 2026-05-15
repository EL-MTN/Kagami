import { Router } from "express";
import { z } from "zod";
import { serviceSummary, serviceTimeline, type TimelineGranularity } from "../storage/metrics.js";

export const servicesRouter = Router();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SummaryQuery = z.object({
  windowHours: z.coerce.number().int().positive().max(720).optional(), // up to 30 days
});

servicesRouter.get("/services", async (req, res, next) => {
  try {
    const params = SummaryQuery.parse(req.query);
    const windowHours = params.windowHours ?? 24;
    const since = new Date(Date.now() - windowHours * HOUR_MS);
    const services = await serviceSummary({ since });
    res.json({ since: since.toISOString(), services });
  } catch (err) {
    next(err);
  }
});

const TimelineQuery = z.object({
  windowHours: z.coerce.number().int().positive().max(720).optional(),
  granularity: z.enum(["minute", "hour", "day"]).optional(),
});

servicesRouter.get("/services/:service/timeline", async (req, res, next) => {
  try {
    const service = req.params.service ?? "";
    if (!service) {
      res.status(400).json({ error: "missing_service" });
      return;
    }
    const params = TimelineQuery.parse(req.query);
    const windowHours = params.windowHours ?? 24;
    const since = new Date(Date.now() - windowHours * HOUR_MS);
    // Auto-pick a sensible granularity if the caller didn't supply one:
    // sub-day → hourly, week+ → daily, otherwise minute.
    const granularity: TimelineGranularity =
      params.granularity ??
      (windowHours <= 2 ? "minute" : windowHours * HOUR_MS >= 7 * DAY_MS ? "day" : "hour");
    const buckets = await serviceTimeline({ service, since, granularity });
    res.json({
      service,
      since: since.toISOString(),
      granularity,
      buckets,
    });
  } catch (err) {
    next(err);
  }
});
