import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { accessTokenSchema, deleteAccountSchema, loginSchema, passwordChangeSchema, passwordResetRequestSchema, passwordResetSchema, profileSchema, registerSchema } from "@vela/validation";
import type { Config } from "../config.js";
import { asyncRoute, parseBody } from "../http.js";
import type { Mailer } from "../mailer.js";
import { requireUser, userId } from "../middleware/auth.js";
import { deleteAccount } from "../services/account.js";
import {
  changePassword,
  clearSessionCookie,
  restorePassword,
  createAccessToken,
  currentUser,
  hashToken,
  loginUser,
  logoutUser,
  listAccessTokens,
  listSessions,
  registerUser,
  requestPasswordReset,
  resetPassword,
  restoreAccessToken,
  restoreSession,
  revokeAccessToken,
  revokeSession,
  setSessionCookie,
  updateProfile,
} from "../services/auth.js";

export function authRouter(config: Config, mailer: Mailer | null): Router {
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
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof passwordResetRequestSchema>>(passwordResetRequestSchema, req.body);
      await requestPasswordReset(body.email, config, mailer);
      res.status(204).end();
    }),
  );

  router.post(
    "/auth/reset",
    limit,
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof passwordResetSchema>>(passwordResetSchema, req.body);
      await resetPassword(body.token, body.password, config);
      clearSessionCookie(res, config);
      res.status(204).end();
    }),
  );

  router.get(
    "/auth/sessions",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.json(await listSessions(userId(req), req.tokenHash));
    }),
  );

  router.delete(
    "/auth/sessions/:id",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const result = await revokeSession(userId(req), req.params.id ?? "", req.tokenHash);
      if (result.current) clearSessionCookie(res, config);
      res.status(204).end();
    }),
  );

  router.post(
    "/auth/sessions/:id/restore",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.json(await restoreSession(userId(req), req.params.id ?? ""));
    }),
  );

  router.post(
    "/auth/tokens",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof accessTokenSchema>>(accessTokenSchema, req.body);
      res.status(201).json(await createAccessToken(userId(req), body.name, config));
    }),
  );

  router.get(
    "/auth/tokens",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.json(await listAccessTokens(userId(req)));
    }),
  );

  router.delete(
    "/auth/tokens/:id",
    requireUser(config),
    asyncRoute(async (req, res) => {
      await revokeAccessToken(userId(req), req.params.id ?? "");
      res.status(204).end();
    }),
  );

  router.post(
    "/auth/tokens/:id/restore",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.json(await restoreAccessToken(userId(req), req.params.id ?? ""));
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

  router.post(
    "/auth/password/restore",
    requireUser(config),
    asyncRoute(async (req, res) => {
      await restorePassword(userId(req));
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

  router.delete(
    "/me",
    requireUser(config),
    asyncRoute(async (req, res) => {
      const body = parseBody<z.infer<typeof deleteAccountSchema>>(deleteAccountSchema, req.body);
      await deleteAccount(userId(req), body.password);
      clearSessionCookie(res, config);
      res.status(204).end();
    }),
  );

  return router;
}
