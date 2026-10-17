import { Router } from "express";
import { z } from "zod";
import {
  assignTaskSchema,
  batchSchema,
  createTaskSchema,
  idempotencyKeySchema,
  reorderSchema,
  pinTaskSchema,
  purgeSelectedSchema,
  restoreSelectedSchema,
  sortTasksSchema,
  taskQuerySchema,
  updateTaskSchema,
} from "@vela/validation";
import type { Config } from "../config.js";
import { HttpError, asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import {
  archiveTask,
  batchTasks,
  clearCompleted,
  completeTask,
  finishSubtasks,
  createTask,
  createTaskIdempotent,
  duplicateTask,
  emptyTrash,
  getTask,
  listTasks,
  omitOccurrence,
  restoreOmittedOccurrence,
  postponeTask,
  pinTask,
  assignTask,
  purgeSelected,
  purgeTask,
  reorderTasks,
  restorePurged,
  restoreSelected,
  restoreTask,
  skipTask,
  softDeleteTask,
  sortListTasks,
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
    "/tasks/sort",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof sortTasksSchema>>(sortTasksSchema, req.body);
      await sortListTasks(userId(req), body.listId, body.by);
      res.status(204).end();
    }),
  );

  router.post(
    "/tasks/batch",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof batchSchema>>(batchSchema, req.body);
      res.json({
        tasks: await batchTasks(
          userId(req),
          body.ids,
          body.action,
          body.listId,
          body.priority,
          body.dueAt,
          body.dueHasTime,
          body.tagId,
          body.tagMode,
          body.reminderOffsetMinutes,
          body.startAt,
          body.estimatedMinutes,
          body.pinned,
          body.assigneeId,
          body.recurrence,
          body.parentId,
        ),
      });
    }),
  );

  router.post(
    "/tasks/empty-trash",
    asyncRoute(async (req, res) => {
      res.json(await emptyTrash(userId(req)));
    }),
  );

  router.post(
    "/tasks/purge",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof purgeSelectedSchema>>(purgeSelectedSchema, req.body);
      res.json(await purgeSelected(userId(req), body.ids));
    }),
  );

  router.post(
    "/tasks/purge/restore",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof restoreSelectedSchema>>(restoreSelectedSchema, req.body);
      res.json(await restorePurged(userId(req), body.ids));
    }),
  );

  router.post(
    "/tasks/restore",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof restoreSelectedSchema>>(restoreSelectedSchema, req.body);
      res.json(await restoreSelected(userId(req), body.ids));
    }),
  );

  router.post(
    "/tasks/clear-completed",
    asyncRoute(async (req, res) => {
      res.json(await clearCompleted(userId(req)));
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

  router.post(
    "/tasks/:id/duplicate",
    asyncRoute(async (req, res) => {
      res.status(201).json(await duplicateTask(userId(req), req.params.id ?? ""));
    }),
  );

  router.post(
    "/tasks/:id/purge",
    asyncRoute(async (req, res) => {
      res.json(await purgeTask(userId(req), req.params.id ?? ""));
    }),
  );

  action("restore", restoreTask);
  action("complete", completeTask);
  action("finish-subtasks", finishSubtasks);
  action("uncomplete", uncompleteTask);
  action("skip", skipTask);
  action("omit", omitOccurrence);
  action("restore-omitted", restoreOmittedOccurrence);
  action("postpone", postponeTask);

  router.post(
    "/tasks/:id/pin",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof pinTaskSchema>>(pinTaskSchema, req.body);
      res.json(await pinTask(userId(req), req.params.id ?? "", body.pinned));
    }),
  );

  router.post(
    "/tasks/:id/assign",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof assignTaskSchema>>(assignTaskSchema, req.body);
      res.json(await assignTask(userId(req), req.params.id ?? "", body.userId));
    }),
  );

  action("archive", archiveTask);
  action("unarchive", unarchiveTask);

  return router;
}
