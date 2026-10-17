import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, sessionCookieHeader, signIn } from "./session.js";

describe("phone session", () => {
  it("keeps only an http origin", () => {
    expect(normalizeBaseUrl(" http://10.0.2.2:4000/inbox ")).toBe("http://10.0.2.2:4000");
    expect(normalizeBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBaseUrl("http://user:pass@10.0.2.2:4000")).toBeNull();
  });

  it("reads the session cookie and ignores other cookies", () => {
    expect(sessionCookieHeader("vela_session=abc.def; Path=/; HttpOnly")).toBe("vela_session=abc.def");
    expect(sessionCookieHeader("other=1")).toBeNull();
  });

  it("signs in and returns the new token", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/auth/login")) {
        return new Response("{}", { headers: { "set-cookie": "vela_session=phone-session; Path=/" } });
      }
      return new Response(JSON.stringify({ token: "kx_phone" }), { status: 201 });
    }) as typeof fetch;
    expect(await signIn("http://10.0.2.2:4000", "ada@example.com", "correct-horse", fetchImpl)).toBe("kx_phone");
  });
});
