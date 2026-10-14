import { Router } from "express";
import mongoose from "mongoose";
import { APP_VERSION } from "@vela/shared";
import type { Config } from "../config.js";
import { asyncRoute } from "../http.js";

export function healthRouter(config: Config): Router {
  const router = Router();
  router.get(
    "/health",
    asyncRoute(async (_req, res) => {
      try {
        await mongoose.connection.db?.admin().ping();
        res.json({ status: "ok", db: "connected", service: "vela-api", time: new Date().toISOString() });
      } catch {
        res.status(503).json({ status: "degraded", db: "unavailable", service: "vela-api", time: new Date().toISOString() });
      }
    }),
  );
  router.get("/meta", (_req, res) => {
    res.json({
      appName: config.appName,
      version: APP_VERSION,
      emailRecovery: false,
      notificationChannels: ["in_app"],
      billing: false,
    });
  });
  return router;
}
