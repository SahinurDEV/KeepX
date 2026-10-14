import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { loginSchema, passwordChangeSchema, profileSchema, registerSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { HttpError, asyncRoute, parseBody } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import {
  changePassword,
  clearSessionCookie,
  currentUser,
  hashToken,
  loginUser,
  logoutUser,
  registerUser,
  setSessionCookie,
  updateProfile,
} from "../services/auth.js";

const recoverySchema = z.object({ email: z.string().trim().email() });

export function authRouter(config: Config): Router {
  const router = Router();
  const limit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config.nodeEnv === "test",
  });

  router.post(
    "/auth/register",
    limit,
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof registerSchema>>(registerSchema, req.body);
      const result = await registerUser(body, req.get("user-agent") ?? "", config);
      setSessionCookie(res, result.token, config);
      res.status(201).json(result.user);
    }),
  );

  router.post(
    "/auth/login",
    limit,
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof loginSchema>>(loginSchema, req.body);
      const result = await loginUser(body, req.get("user-agent") ?? "", config);
      setSessionCookie(res, result.token, config);
      res.json(result.user);
    }),
  );

  router.post(
    "/auth/logout",
    asyncRoute(async (req, res) => {
      const token = req.cookies?.vela_session;
      if (typeof token === "string") await logoutUser(hashToken(token, config.sessionSecret));
      clearSessionCookie(res, config);
      res.status(204).end();
    }),
  );

  router.post(
    "/auth/recovery",
    limit,
    asyncRoute(async (req, _res) => {
      parseBody<z.infer<typeof recoverySchema>>(recoverySchema, req.body);
      throw new HttpError(503, "EMAIL_NOT_CONFIGURED", "Password recovery email is not configured.");
    }),
  );

  router.post(
    "/auth/password",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof passwordChangeSchema>>(passwordChangeSchema, req.body);
      await changePassword(userId(req), req.tokenHash ?? "", body, config);
      res.status(204).end();
    }),
  );

  router.get(
    "/me",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.json(await currentUser(userId(req)));
    }),
  );

  router.patch(
    "/me",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof profileSchema>>(profileSchema, req.body);
      res.json(await updateProfile(userId(req), body));
    }),
  );

  return router;
}
