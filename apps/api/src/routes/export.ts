import { Router } from "express";
import type { Config } from "../config.js";
import { asyncRoute } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { exportAccount } from "../services/export.js";

export function exportRouter(config: Config): Router {
  const router = Router();
  router.get(
    "/export",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.setHeader("content-disposition", "attachment; filename=\"keepx-export.json\"");
      res.json(await exportAccount(userId(req)));
    }),
  );
  return router;
}
