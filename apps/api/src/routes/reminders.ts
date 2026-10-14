import { Router } from "express";
import type { Config } from "../config.js";
import { asyncRoute } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { acknowledgeReminder, pendingReminders } from "../services/reminders.js";

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

  return router;
}
