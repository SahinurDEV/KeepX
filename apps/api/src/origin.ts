const extensionOrigins = ["chrome-extension://", "moz-extension://"];

export function isAllowedOrigin(origin: string | undefined, appOrigin: string): boolean {
  if (!origin) return true;
  if (origin === appOrigin) return true;
  return extensionOrigins.some((prefix) => origin.startsWith(prefix));
}
