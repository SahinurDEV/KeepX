import { Router } from "express";
import mongoose from "mongoose";
import { APP_VERSION, type MetaDto } from "@vela/shared";
import type { Config } from "../config.js";
import { asyncRoute } from "../http.js";

export interface NotificationFlags {
  email: boolean;
  webPush: boolean;
  expoPush: boolean;
  webPushPublicKey: string | null;
  billing: boolean;
}

export function notificationChannels(flags: NotificationFlags): MetaDto["notificationChannels"] {
  const channels: MetaDto["notificationChannels"] = ["in_app"];
  if (flags.email) channels.push("email");
  if (flags.webPush) channels.push("web_push");
  if (flags.expoPush) channels.push("expo_push");
  return channels;
}

export function healthRouter(config: Config, flags: NotificationFlags): Router {
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
      emailRecovery: flags.email,
      notificationChannels: notificationChannels(flags),
      webPushPublicKey: flags.webPushPublicKey,
      billing: flags.billing,
    });
  });
  return router;
}
