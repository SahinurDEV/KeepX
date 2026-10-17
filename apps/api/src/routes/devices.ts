import { Router } from "express";
import { z } from "zod";
import { registerDeviceSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { listDevices, registerDevice, removeDevice } from "../services/devices.js";

export function deviceRouter(config: Config): Router {
  const router = Router();
  router.use(requireUser(config));

  router.get(
    "/devices",
    asyncRoute(async (req, res) => {
      res.json(await listDevices(userId(req)));
    }),
  );

  router.post(
    "/devices",
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof registerDeviceSchema>>(registerDeviceSchema, req.body);
      const result = await registerDevice(userId(req), body);
      res.status(result.created ? 201 : 200).json(result.device);
    }),
  );

  router.delete(
    "/devices/:id",
    asyncRoute(async (req, res) => {
      res.json(await removeDevice(userId(req), req.params.id ?? ""));
    }),
  );

  return router;
}
