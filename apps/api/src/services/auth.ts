import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Response } from "express";
import { assertTimeZone } from "@vela/shared";
import type { Config } from "../config.js";
import { HttpError, isDuplicateKey } from "../http.js";
import { List, Session, User } from "../models.js";
import { toUserDto } from "../serialize.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
let dummyHash: Promise<string> | null = null;

export function primeDummyHash(cost: number): Promise<string> {
  dummyHash ??= bcrypt.hash("vela-timing-pad", cost);
  return dummyHash;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string, secret: string): string {
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

export function setSessionCookie(res: Response, token: string, config: Config): void {
  res.cookie("vela_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: SESSION_MS,
  });
}

export function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie("vela_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
  });
}

async function openSession(userId: unknown, userAgent: string, config: Config): Promise<string> {
  const token = newSessionToken();
  await Session.create({
    userId,
    tokenHash: hashToken(token, config.sessionSecret),
    expiresAt: new Date(Date.now() + SESSION_MS),
    userAgent: userAgent.slice(0, 300),
  });
  return token;
}

export async function registerUser(
  input: { name: string; email: string; password: string; timeZone?: string },
  userAgent: string,
  config: Config,
) {
  const email = input.email.toLowerCase();
  const timeZone = input.timeZone ?? "UTC";
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
  }
  const existing = await User.findOne({ email });
  if (existing) throw new HttpError(409, "EMAIL_IN_USE", "An account with that email already exists.");
  const passwordHash = await bcrypt.hash(input.password, config.bcryptCost);
  const user = await User.create({ email, passwordHash, name: input.name, timeZone });
  await List.create({
    userId: user._id,
    name: "Inbox",
    color: "clay",
    icon: "inbox",
    sortOrder: 0,
    isInbox: true,
  });
  const token = await openSession(user._id, userAgent, config);
  return { user: toUserDto(user), token };
}

export async function loginUser(input: { email: string; password: string }, userAgent: string, config: Config) {
  const email = input.email.toLowerCase();
  const user = await User.findOne({ email });
  const hash = user?.passwordHash ?? (await primeDummyHash(config.bcryptCost));
  const matches = await bcrypt.compare(input.password, hash);
  if (!user || !matches) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  const token = await openSession(user._id, userAgent, config);
  return { user: toUserDto(user), token };
}

export async function logoutUser(tokenHash: string | undefined): Promise<void> {
  if (tokenHash) await Session.deleteOne({ tokenHash });
}

export async function changePassword(
  userId: string,
  tokenHash: string,
  input: { currentPassword: string; newPassword: string },
  config: Config,
): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  const matches = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!matches) throw new HttpError(400, "INVALID_PASSWORD", "The current password is incorrect.");
  user.passwordHash = await bcrypt.hash(input.newPassword, config.bcryptCost);
  await user.save();
  await Session.deleteMany({ userId: user._id, tokenHash: { $ne: tokenHash } });
}

export async function updateProfile(userId: string, input: { name?: string; timeZone?: string }) {
  if (input.timeZone) {
    try {
      assertTimeZone(input.timeZone);
    } catch {
      throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
    }
  }
  const user = await User.findByIdAndUpdate(userId, { $set: input }, { new: true });
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return toUserDto(user);
}

export async function currentUser(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return toUserDto(user);
}

export async function assertUniqueEmail(error: unknown): Promise<void> {
  if (isDuplicateKey(error)) throw new HttpError(409, "EMAIL_IN_USE", "An account with that email already exists.");
}
