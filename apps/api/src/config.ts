export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass: string;
  from: string;
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface Config {
  port: number;
  mongoUri: string;
  sessionSecret: string;
  appOrigin: string;
  cookieSecure: boolean;
  bcryptCost: number;
  appName: string;
  trustProxy: boolean;
  nodeEnv: string;
  smtp: SmtpConfig | null;
  webPush: WebPushConfig | null;
  expoAccessToken: string | null;
  stripe: StripeConfig | null;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
}

export function getConfig(): Config {
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }
  const bcryptCost = Number(process.env.BCRYPT_COST ?? 12);
  if (!Number.isInteger(bcryptCost) || bcryptCost < 4 || bcryptCost > 15) {
    throw new Error("BCRYPT_COST must be an integer from 4 to 15.");
  }
  const smtp = readSmtp();
  return {
    port: Number(process.env.PORT ?? 4000),
    mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/vela",
    sessionSecret,
    appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
    cookieSecure: process.env.COOKIE_SECURE === "true",
    bcryptCost,
    appName: process.env.APP_NAME?.trim() || "KeepX",
    trustProxy: process.env.TRUST_PROXY === "true",
    nodeEnv: process.env.NODE_ENV ?? "development",
    smtp,
    webPush: readWebPush(),
    expoAccessToken: readExpoAccessToken(),
    stripe: readStripe(),
  };
}

function readSmtp(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim() ?? "";
  const from = process.env.SMTP_FROM?.trim() ?? "";
  if (!host || !from) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be an integer from 1 to 65535.");
  }
  const user = process.env.SMTP_USER?.trim();
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    user: user || undefined,
    pass: process.env.SMTP_PASS ?? "",
    from,
  };
}

function readWebPush(): WebPushConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey && !privateKey && !subject) return null;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set.");
  }
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,80}$/.test(privateKey)) {
    throw new Error("VAPID keys must be base64url.");
  }
  if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\/\S+$/.test(subject)) {
    throw new Error("VAPID_SUBJECT must be a mailto or https URL.");
  }
  return { publicKey, privateKey, subject };
}

function readStripe(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const priceId = process.env.STRIPE_PRICE_ID?.trim() ?? "";
  if (!secretKey && !webhookSecret && !priceId) return null;
  if (!secretKey || !webhookSecret || !priceId) {
    throw new Error("STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRICE_ID must all be set.");
  }
  if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(secretKey) || secretKey.length < 20) {
    throw new Error("STRIPE_SECRET_KEY is not valid.");
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret) || webhookSecret.length < 12) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not valid.");
  }
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) throw new Error("STRIPE_PRICE_ID is not valid.");
  return { secretKey, webhookSecret, priceId };
}

function readExpoAccessToken(): string | null {
  const token = process.env.EXPO_ACCESS_TOKEN?.trim() ?? "";
  if (!token) return null;
  if (token.length < 10 || /\s/.test(token)) throw new Error("EXPO_ACCESS_TOKEN is not valid.");
  return token;
}
