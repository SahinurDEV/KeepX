import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Response } from "express";
import { assertTimeZone } from "@vela/shared";
import type { Config } from "../config.js";
import { HttpError, isDuplicateKey } from "../http.js";
import type { Mailer } from "../mailer.js";
import { AccessToken, List, PasswordReset, Session, User } from "../models.js";
import { toUserDto } from "../serialize.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const PASSWORD_UNDO_MS = 5 * 60 * 1000;
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
  user.previousPasswordHash = user.passwordHash;
  user.previousPasswordUntil = new Date(Date.now() + PASSWORD_UNDO_MS);
  user.passwordHash = await bcrypt.hash(input.newPassword, config.bcryptCost);
  await user.save();
  await Session.deleteMany({ userId: user._id, tokenHash: { $ne: tokenHash } });
  await AccessToken.deleteMany({ userId: user._id });
}

export async function restorePassword(userId: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  if (!user.previousPasswordHash || !user.previousPasswordUntil || user.previousPasswordUntil.getTime() <= Date.now()) {
    throw new HttpError(404, "NOT_FOUND", "The previous password is no longer available.");
  }
  user.passwordHash = user.previousPasswordHash;
  user.previousPasswordHash = null;
  user.previousPasswordUntil = null;
  await user.save();
}

export async function requestPasswordReset(email: string, config: Config, mailer: Mailer | null): Promise<void> {
  if (!mailer) {
    throw new HttpError(503, "EMAIL_NOT_CONFIGURED", "Password recovery email is not configured.");
  }
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return;
  const token = newSessionToken();
  await PasswordReset.deleteMany({ userId: user._id });
  await PasswordReset.create({
    userId: user._id,
    tokenHash: hashToken(token, config.sessionSecret),
    expiresAt: new Date(Date.now() + RESET_MS),
  });
  const link = `${config.appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await mailer.send({
      to: user.email,
      subject: `${config.appName} password reset`,
      text: `A password reset was requested for ${config.appName}. Open this link within one hour:\n\n${link}\n\nIf you did not ask for this, ignore this message.`,
    });
  } catch {
    await PasswordReset.deleteMany({ userId: user._id });
    console.error(JSON.stringify({ level: "error", event: "recovery_mail_failed" }));
  }
}

export async function resetPassword(token: string, newPassword: string, config: Config): Promise<void> {
  const row = await PasswordReset.findOne({
    tokenHash: hashToken(token, config.sessionSecret),
    expiresAt: { $gt: new Date() },
  });
  if (!row) throw new HttpError(400, "INVALID_RESET", "This reset link is invalid or expired.");
  const user = await User.findById(row.userId);
  if (!user) {
    await PasswordReset.deleteOne({ _id: row._id });
    throw new HttpError(400, "INVALID_RESET", "This reset link is invalid or expired.");
  }
  user.passwordHash = await bcrypt.hash(newPassword, config.bcryptCost);
  user.previousPasswordHash = null;
  user.previousPasswordUntil = null;
  await user.save();
  await Session.deleteMany({ userId: user._id });
  await PasswordReset.deleteMany({ userId: user._id });
  await AccessToken.deleteMany({ userId: user._id });
}

export async function createAccessToken(userId: string, name: string, config: Config) {
  const count = await AccessToken.countDocuments({ userId, revokedAt: null });
  if (count >= 10) throw new HttpError(400, "TOKEN_LIMIT", "Revoke an old token before creating another.");
  const token = `kx_${newSessionToken()}`;
  const row = await AccessToken.create({
    userId,
    name,
    tokenHash: hashToken(token, config.sessionSecret),
    revokedAt: null,
  });
  return { id: row._id.toString(), name: row.name, token, createdAt: row.createdAt.toISOString() };
}

export async function listSessions(userId: string, tokenHash: string | undefined) {
  const rows = await Session.find({ userId, expiresAt: { $gt: new Date() }, revokedAt: null }).sort({ createdAt: -1 });
  return rows.map((row) => ({
    id: row._id.toString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    userAgent: row.userAgent,
    current: Boolean(tokenHash) && row.tokenHash === tokenHash,
  }));
}

export async function revokeSession(userId: string, sessionId: string, tokenHash: string | undefined): Promise<{ current: boolean }> {
  if (!/^[a-f\d]{24}$/i.test(sessionId)) throw new HttpError(404, "NOT_FOUND", "Session not found.");
  const row = await Session.findOne({ _id: sessionId, userId, revokedAt: null });
  if (!row) throw new HttpError(404, "NOT_FOUND", "Session not found.");
  const current = Boolean(tokenHash) && row.tokenHash === tokenHash;
  if (current) {
    await row.deleteOne();
  } else {
    row.revokedAt = new Date();
    await row.save();
  }
  return { current };
}

export async function restoreSession(userId: string, sessionId: string): Promise<{ id: string; createdAt: string; expiresAt: string; userAgent: string; current: false }> {
  if (!/^[a-f\d]{24}$/i.test(sessionId)) throw new HttpError(404, "NOT_FOUND", "Session not found.");
  const row = await Session.findOne({ _id: sessionId, userId });
  if (!row?.revokedAt) throw new HttpError(404, "NOT_FOUND", "That browser is not signed out.");
  if (row.expiresAt.getTime() <= Date.now()) throw new HttpError(404, "NOT_FOUND", "That browser session has expired.");
  row.revokedAt = null;
  await row.save();
  return {
    id: row._id.toString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    userAgent: row.userAgent,
    current: false,
  };
}

export async function listAccessTokens(userId: string) {
  const rows = await AccessToken.find({ userId, revokedAt: null }).sort({ createdAt: -1 });
  return rows.map((row) => ({ id: row._id.toString(), name: row.name, createdAt: row.createdAt.toISOString() }));
}

export async function revokeAccessToken(userId: string, tokenId: string) {
  if (!/^[a-f\d]{24}$/i.test(tokenId)) throw new HttpError(404, "NOT_FOUND", "Token not found.");
  const row = await AccessToken.findOneAndUpdate(
    { _id: tokenId, userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (!row) throw new HttpError(404, "NOT_FOUND", "Token not found.");
}

export async function restoreAccessToken(userId: string, tokenId: string) {
  if (!/^[a-f\d]{24}$/i.test(tokenId)) throw new HttpError(404, "NOT_FOUND", "Token not found.");
  const row = await AccessToken.findOne({ _id: tokenId, userId });
  if (!row?.revokedAt) throw new HttpError(404, "NOT_FOUND", "That token is not revoked.");
  if ((await AccessToken.countDocuments({ userId, revokedAt: null })) >= 10) {
    throw new HttpError(400, "TOKEN_LIMIT", "Revoke an old token before restoring this one.");
  }
  row.revokedAt = null;
  await row.save();
  return { id: row._id.toString(), name: row.name, createdAt: row.createdAt.toISOString() };
}

export async function updateProfile(
  userId: string,
  input: { name?: string; timeZone?: string; emailReminders?: boolean; pushReminders?: boolean },
) {
  if (input.timeZone) {
    try {
      assertTimeZone(input.timeZone);
    } catch {
      throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
    }
  }
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  if (input.name !== undefined && input.name !== user.name) user.name = input.name;
  if (input.timeZone !== undefined && input.timeZone !== user.timeZone) user.timeZone = input.timeZone;
  if (input.emailReminders !== undefined && input.emailReminders !== user.emailReminders) user.emailReminders = input.emailReminders;
  if (input.pushReminders !== undefined && input.pushReminders !== user.pushReminders) user.pushReminders = input.pushReminders;
  if (!user.isModified()) return toUserDto(user);
  await user.save();
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
