import { Router } from "express";
import { z } from "zod";
import { createListSchema, reorderSchema, shareListSchema, updateListSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { createList, deleteList, listLists, listMembers, rejoinList, removeMember, reorderLists, shareList, updateList } from "../services/organize.js";
import { duplicateList } from "../services/tasks.js";

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

  router.post(
    "/lists/reorder",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof reorderSchema>>(reorderSchema, req.body);
      await reorderLists(userId(req), body.ids);
      res.status(204).end();
    }),
  );

  router.get(
    "/lists/:id/members",
    asyncRoute(async (req, res) => {
      res.json(await listMembers(userId(req), req.params.id ?? ""));
    }),
  );

  router.post(
    "/lists/:id/members",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof shareListSchema>>(shareListSchema, req.body);
      const member = await shareList(userId(req), req.params.id ?? "", body.email);
      res.status(member.added ? 201 : 200).json(member);
    }),
  );

  router.delete(
    "/lists/:id/members/:memberId",
    asyncRoute(async (req, res) => {
      await removeMember(userId(req), req.params.id ?? "", req.params.memberId ?? "");
      res.status(204).end();
    }),
  );

  router.post(
    "/lists/:id/rejoin",
    asyncRoute(async (req, res) => {
      res.json(await rejoinList(userId(req), req.params.id ?? ""));
    }),
  );

  router.post(
    "/lists/:id/duplicate",
    asyncRoute(async (req, res) => {
      res.status(201).json(await duplicateList(userId(req), req.params.id ?? ""));
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
