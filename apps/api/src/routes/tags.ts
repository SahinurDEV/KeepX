import { Router } from "express";
import { z } from "zod";
import { createTagSchema, updateTagSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { createTag, deleteTag, listTags, updateTag } from "../services/organize.js";

export function tagRouter(config: Config): Router {
  const router = Router();
  router.use(requireUser(config));

  router.get(
    "/tags",
    asyncRoute(async (req, res) => {
      res.json(await listTags(userId(req)));
    }),
  );

  router.post(
    "/tags",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof createTagSchema>>(createTagSchema, req.body);
      res.status(201).json(await createTag(userId(req), body));
    }),
  );

  router.patch(
    "/tags/:id",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof updateTagSchema>>(updateTagSchema, req.body);
      const patch: { name?: string; color?: z.infer<typeof updateTagSchema>["color"] } = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.color !== undefined) patch.color = body.color;
      res.json(await updateTag(userId(req), req.params.id ?? "", patch));
    }),
  );

  router.delete(
    "/tags/:id",
    asyncRoute(async (req, res) => {
      await deleteTag(userId(req), req.params.id ?? "");
      res.status(204).end();
    }),
  );

  return router;
}
