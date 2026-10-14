import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import { Session } from "../models.js";
import { hashToken } from "../services/auth.js";

export function requireUser(config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.vela_session;
      if (!token || typeof token !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      }
      const tokenHash = hashToken(token, config.sessionSecret);
      const session = await Session.findOne({ tokenHash, expiresAt: { $gt: new Date() } });
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
