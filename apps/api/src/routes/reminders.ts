import { Router } from "express";
import { z } from "zod";
import { snoozeReminderSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { acknowledgeReminder, pendingReminders, snoozeReminder, unacknowledgeReminder } from "../services/reminders.js";

export function reminderRouter(config: Config): Router {
  const router = Router();
  router.use(requireUser(config));

  router.get(
    "/reminders/pending",
    asyncRoute(async (req, res) => {
      res.json(await pendingReminders(userId(req)));
    }),
  );

  router.post(
    "/reminders/:id/ack",
    asyncRoute(async (req, res) => {
      await acknowledgeReminder(userId(req), req.params.id ?? "");
      res.status(204).end();
    }),
  );

  router.post(
    "/reminders/:id/unack",
    asyncRoute(async (req, res) => {
      await unacknowledgeReminder(userId(req), req.params.id ?? "");
      res.status(204).end();
    }),
  );

  router.post(
    "/reminders/:id/snooze",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof snoozeReminderSchema>>(snoozeReminderSchema, req.body);
      res.json(await snoozeReminder(userId(req), req.params.id ?? "", body));
    }),
  );

  return router;
}
