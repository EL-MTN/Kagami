import { Router } from "express";
import { isConsolidationRunning, runConsolidationOnce } from "../maintenance/scheduler.js";

// Manual trigger for the durable-only consolidation pass. server.ts mounts
// this ONLY when KIOKU_CONSOLIDATE_ENABLED is true, so it shares the cron's
// explicit opt-in — an unauthenticated destructive endpoint must not exist by
// default (Kioku has no auth layer; see ARCHITECTURE.md's local-trust note,
// and reintroduce auth before any non-localhost exposure).
//
// Fire-and-forget: a full convergence pass is several LLM rounds and can run
// for minutes, so we kick it off and return 202 rather than holding the
// connection open. The outcome is logged (and shipped to Kansoku). 409 when a
// pass is already in flight — the run shares the scheduler's process-wide lock,
// so a request that slips past this check still no-ops rather than racing.
export const consolidateRouter = Router();

consolidateRouter.post("/", (_req, res) => {
  if (isConsolidationRunning()) {
    res.status(409).json({ status: "busy", message: "a consolidation pass is already in flight" });
    return;
  }
  void runConsolidationOnce();
  res.status(202).json({ status: "started" });
});
