import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import { HttpError, errorHandler } from "./http.js";
import { primeDummyHash } from "./services/auth.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { listRouter } from "./routes/lists.js";
import { reminderRouter } from "./routes/reminders.js";
import { tagRouter } from "./routes/tags.js";
import { taskRouter } from "./routes/tasks.js";

export async function createApp(): Promise<Express> {
  const config = getConfig();
  mongoose.set("strictQuery", true);
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri);
  }
  await primeDummyHash(config.bcryptCost);

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.appOrigin, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
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
    if (origin && origin !== config.appOrigin) {
      next(new HttpError(403, "ORIGIN_REJECTED", "This origin is not allowed."));
      return;
    }
    next();
  });

  const api = express.Router();
  api.use(healthRouter(config));
  api.use(authRouter(config));
  api.use(listRouter(config));
  api.use(tagRouter(config));
  api.use(taskRouter(config));
  api.use(reminderRouter(config));
  app.use("/api/v1", api);
  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "That route does not exist.")));
  app.use(errorHandler);
  return app;
}
