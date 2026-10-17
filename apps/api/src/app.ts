import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Request as ExpressRequest } from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { createBilling, type Billing } from "./billing.js";
import { getConfig } from "./config.js";
import { HttpError, errorHandler } from "./http.js";
import { createSmtpMailer, type Mailer } from "./mailer.js";
import { isAllowedOrigin } from "./origin.js";
import { primeDummyHash } from "./services/auth.js";
import { authRouter } from "./routes/auth.js";
import { createPushSender, type PushSender } from "./push.js";
import { billingRouter } from "./routes/billing.js";
import { deviceRouter } from "./routes/devices.js";
import { exportRouter } from "./routes/export.js";
import { healthRouter } from "./routes/health.js";
import { importRouter } from "./routes/import.js";
import { listRouter } from "./routes/lists.js";
import { reminderRouter } from "./routes/reminders.js";
import { tagRouter } from "./routes/tags.js";
import { taskRouter } from "./routes/tasks.js";

export async function createApp(options?: { mailer?: Mailer | null; push?: PushSender | null; billing?: Billing | null }): Promise<Express> {
  const config = getConfig();
  const mailer = options && "mailer" in options ? (options.mailer ?? null) : createSmtpMailer(config);
  const push = options && "push" in options ? (options.push ?? null) : createPushSender(config);
  const billing = options && "billing" in options ? (options.billing ?? null) : createBilling(config);
  mongoose.set("strictQuery", true);
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri);
  }
  await primeDummyHash(config.bcryptCost);

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || isAllowedOrigin(origin, config.appOrigin)) callback(null, origin ?? true);
        else callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(
    express.json({
      limit: "1mb",
      verify(req, _res, buf) {
        if (req.url?.startsWith("/api/v1/billing/webhook")) {
          (req as ExpressRequest & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(cookieParser());
  app.use((req, res, next) => {
    req.requestId = req.get("x-request-id") || randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const started = Date.now();
    res.on("finish", () => {
      console.log(
        JSON.stringify({
          level: "info",
          time: new Date().toISOString(),
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Date.now() - started,
        }),
      );
    });
    const origin = req.get("origin");
    if (!isAllowedOrigin(origin, config.appOrigin)) {
      next(new HttpError(403, "ORIGIN_REJECTED", "This origin is not allowed."));
      return;
    }
    next();
  });

  const api = express.Router();
  api.use(
    healthRouter(config, {
      email: mailer !== null,
      webPush: push?.canSend("web") ?? false,
      expoPush: push?.canSend("expo") ?? false,
      webPushPublicKey: push?.webPushPublicKey ?? null,
      billing: billing !== null,
    }),
  );
  api.use(authRouter(config, mailer));
  api.use(billingRouter(config, billing));
  api.use(deviceRouter(config));
  api.use(exportRouter(config));
  api.use(importRouter(config));
  api.use(listRouter(config));
  api.use(tagRouter(config));
  api.use(taskRouter(config));
  api.use(reminderRouter(config));
  app.use("/api/v1", api);
  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "That route does not exist.")));
  app.use(errorHandler);
  return app;
}
