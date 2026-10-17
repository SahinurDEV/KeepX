import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import { AccessToken, Session } from "../models.js";
import { hashToken } from "../services/auth.js";

export function requireUser(config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.get("authorization");
      if (header?.toLowerCase().startsWith("bearer ")) {
        const raw = header.slice(7).trim();
        const access = raw
          ? await AccessToken.findOne({ tokenHash: hashToken(raw, config.sessionSecret), revokedAt: null })
          : null;
        if (!access) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
        req.userId = access.userId.toString();
        next();
        return;
      }
      const token = req.cookies?.vela_session;
      if (!token || typeof token !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      }
      const tokenHash = hashToken(token, config.sessionSecret);
      const session = await Session.findOne({ tokenHash, expiresAt: { $gt: new Date() }, revokedAt: null });
      if (!session) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      req.userId = session.userId.toString();
      req.tokenHash = tokenHash;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function userId(req: Request): string {
  if (!req.userId) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return req.userId;
}
