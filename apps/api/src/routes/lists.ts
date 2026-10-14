import { Router } from "express";
import { z } from "zod";
import { createListSchema, updateListSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { createList, deleteList, listLists, updateList } from "../services/organize.js";

export function listRouter(config: Config): Router {
  const router = Router();
  router.use(requireUser(config));

  router.get(
    "/lists",
    asyncRoute(async (req, res) => {
      res.json(await listLists(userId(req)));
    }),
  );

  router.post(
    "/lists",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof createListSchema>>(createListSchema, req.body);
      res.status(201).json(await createList(userId(req), body));
    }),
  );

  router.patch(
    "/lists/:id",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof updateListSchema>>(updateListSchema, req.body);
      res.json(await updateList(userId(req), req.params.id ?? "", body));
    }),
  );

  router.delete(
    "/lists/:id",
    asyncRoute(async (req, res) => {
      await deleteList(userId(req), req.params.id ?? "");
      res.status(204).end();
    }),
  );

  return router;
}
