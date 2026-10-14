import { Router } from "express";
import { z } from "zod";
import {
  batchSchema,
  createTaskSchema,
  idempotencyKeySchema,
  reorderSchema,
  taskQuerySchema,
  updateTaskSchema,
} from "@vela/validation";
import type { Config } from "../config.js";
import { HttpError, asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import {
  archiveTask,
  batchTasks,
  completeTask,
  createTask,
  createTaskIdempotent,
  getTask,
  listTasks,
  reorderTasks,
  restoreTask,
  skipTask,
  softDeleteTask,
  unarchiveTask,
  uncompleteTask,
  updateTask,
  type TaskQuery,
} from "../services/tasks.js";

export function taskRouter(config: Config): Router {
  const router = Router();
  router.use(requireUser(config));

  router.get(
    "/tasks",
    asyncRoute(async (req, res) => {
      const query = parseBody<z.infer<typeof taskQuerySchema>>(taskQuerySchema, req.query);
      res.json(await listTasks(userId(req), query as TaskQuery));
    }),
  );

  router.post(
    "/tasks/reorder",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof reorderSchema>>(reorderSchema, req.body);
      await reorderTasks(userId(req), body.ids);
      res.status(204).end();
    }),
  );

  router.post(
    "/tasks/batch",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof batchSchema>>(batchSchema, req.body);
      res.json({ tasks: await batchTasks(userId(req), body.ids, body.action) });
    }),
  );

  router.post(
    "/tasks",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof createTaskSchema>>(createTaskSchema, req.body);
      const key = req.get("idempotency-key");
      if (key) {
        const parsed = idempotencyKeySchema.safeParse(key);
        if (!parsed.success) throw new HttpError(400, "IDEMPOTENCY_KEY", "The idempotency key is invalid.");
        res.status(201).json(await createTaskIdempotent(userId(req), parsed.data, body));
        return;
      }
      res.status(201).json(await createTask(userId(req), body));
    }),
  );

  router.get(
    "/tasks/:id",
    asyncRoute(async (req, res) => {
      res.json(await getTask(userId(req), req.params.id ?? ""));
    }),
  );

  router.patch(
    "/tasks/:id",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof updateTaskSchema>>(updateTaskSchema, req.body);
      const { revision, ...patch } = body;
      res.json(await updateTask(userId(req), req.params.id ?? "", revision, patch));
    }),
  );

  router.delete(
    "/tasks/:id",
    asyncRoute(async (req, res) => {
      res.json(await softDeleteTask(userId(req), req.params.id ?? ""));
    }),
  );

  const action = (name: string, run: (userId: string, taskId: string) => Promise<unknown>) => {
    router.post(
      `/tasks/:id/${name}`,
      asyncRoute(async (req, res) => {
        res.json(await run(userId(req), req.params.id ?? ""));
      }),
    );
  };

  action("restore", restoreTask);
  action("complete", completeTask);
  action("uncomplete", uncompleteTask);
  action("skip", skipTask);
  action("archive", archiveTask);
  action("unarchive", unarchiveTask);

  return router;
}
