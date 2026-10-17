import { Router } from "express";
import { z } from "zod";
import { importAccountSchema, revertImportSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { importAccount, revertImport } from "../services/import.js";

export function importRouter(config: Config): Router {
  const router = Router();
  router.post(
    "/import",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof importAccountSchema>>(importAccountSchema, req.body);
      res.status(201).json(await importAccount(userId(req), body));
    }),
  );
  router.post(
    "/import/revert",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof revertImportSchema>>(revertImportSchema, req.body);
      res.json(await revertImport(userId(req), body));
    }),
  );
  return router;
}
