import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./origin.js";

describe("request origin", () => {
  const appOrigin = "http://localhost:3000";

  it("allows the web app, browser extensions, and requests with no origin", () => {
    expect(isAllowedOrigin(undefined, appOrigin)).toBe(true);
    expect(isAllowedOrigin(appOrigin, appOrigin)).toBe(true);
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnopqrstuvwxyz", appOrigin)).toBe(true);
    expect(isAllowedOrigin("moz-extension://abcdefghijklmnopqrstuvwxyz", appOrigin)).toBe(true);
    expect(isAllowedOrigin("https://mail.google.com", appOrigin)).toBe(false);
    expect(isAllowedOrigin("http://evil.example", appOrigin)).toBe(false);
  });
});