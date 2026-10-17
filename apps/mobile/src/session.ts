export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = /(?:^|,\s*)vela_session=([^;,\s]+)/.exec(setCookie);
  const token = match?.[1];
  if (!token) return null;
  return `vela_session=${token}`;
}

interface TokenResponse {
  token?: string;
}

export async function signIn(
  baseUrl: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const login = await fetchImpl(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error("Email or password is incorrect.");
  const cookie = sessionCookieHeader(login.headers.get("set-cookie"));
  if (!cookie) throw new Error("The server did not start a session.");
  const created = await fetchImpl(`${baseUrl}/api/v1/auth/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Android" }),
  });
  const body = (await created.json().catch(() => null)) as TokenResponse | null;
  if (!created.ok || !body?.token) throw new Error("Could not create a phone token.");
  return body.token;
}
