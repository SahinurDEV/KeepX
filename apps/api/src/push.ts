import webpush from "web-push";
import type { Config } from "./config.js";

export type PushProvider = "web" | "expo";

export interface PushMessage {
  provider: PushProvider;
  token: string;
  title: string;
  body: string;
}

export interface PushSender {
  webPushPublicKey: string | null;
  canSend(provider: PushProvider): boolean;
  send(message: PushMessage): Promise<void>;
}

export class ExpiredPushTokenError extends Error {
  constructor() {
    super("Push token is no longer registered.");
    this.name = "ExpiredPushTokenError";
  }
}

export function createPushSender(config: Config): PushSender | null {
  const web = config.webPush;
  const expoAccessToken = config.expoAccessToken;
  if (!web && !expoAccessToken) return null;
  if (web) webpush.setVapidDetails(web.subject, web.publicKey, web.privateKey);
  return {
    webPushPublicKey: web?.publicKey ?? null,
    canSend(provider) {
      return provider === "web" ? web !== null : expoAccessToken !== null;
    },
    async send(message) {
      if (message.provider === "web") {
        if (!web) throw new Error("Web push is not configured.");
        await sendWeb(message);
        return;
      }
      if (!expoAccessToken) throw new Error("Phone push is not configured.");
      await sendExpo(expoAccessToken, message);
    },
  };
}

async function sendWeb(message: PushMessage): Promise<void> {
  let subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  try {
    subscription = JSON.parse(message.token) as { endpoint: string; keys: { p256dh: string; auth: string } };
  } catch {
    throw new ExpiredPushTokenError();
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title: message.title, body: message.body }));
  } catch (error) {
    const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
    if (status === 404 || status === 410) throw new ExpiredPushTokenError();
    throw new Error("Web push was rejected.");
  }
}

async function sendExpo(accessToken: string, message: PushMessage): Promise<void> {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: message.token, title: message.title, body: message.body, sound: "default" }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: { status?: string; details?: { error?: string } };
  } | null;
  if (payload?.data?.details?.error === "DeviceNotRegistered") throw new ExpiredPushTokenError();
  if (!response.ok || payload?.data?.status === "error") throw new Error("Expo push was rejected.");
}
