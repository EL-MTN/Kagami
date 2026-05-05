import { Router } from "express";
import { buildManifest, type EndpointSpec } from "../manifest.js";
import { peopleEndpoints } from "./people.js";
import { organizationsEndpoints } from "./organizations.js";
import { interactionsEndpoints } from "./interactions.js";
import { followupsEndpoints } from "./followups.js";
import { contextsEndpoints } from "./contexts.js";
import { digestEndpoints } from "./digest.js";
import { syncEndpoints } from "./sync.js";

export const allEndpoints: EndpointSpec[] = [
  ...peopleEndpoints,
  ...organizationsEndpoints,
  ...interactionsEndpoints,
  ...followupsEndpoints,
  ...contextsEndpoints,
  ...digestEndpoints,
  ...syncEndpoints,
];

const manifestData = buildManifest(allEndpoints);

export const manifestRouter = Router();

manifestRouter.get("/_manifest", (_req, res) => {
  res.json(manifestData);
});
