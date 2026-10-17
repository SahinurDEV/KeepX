export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

export function isErrorPage(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== "file:") return false;
    const path = decodeURIComponent(target.pathname).replaceAll("\\", "/");
    return path.endsWith("/static/offline.html");
  } catch {
    return false;
  }
}

export function isAllowedNavigation(url: string, appOrigin: string): boolean {
  return isAppUrl(url, appOrigin) || isErrorPage(url);
}

export function isExternalHttp(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function readNotice(value: unknown): { title: string; body: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || typeof record.body !== "string") return null;
  const title = record.title.replace(/[\r\n]/g, " ").trim();
  const body = record.body.replace(/[\r\n]/g, " ").trim();
  if (!title || title.length > 120 || body.length > 500) return null;
  return { title, body };
}
