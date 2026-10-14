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
  };
}
