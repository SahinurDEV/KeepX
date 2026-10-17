import { describe, expect, it } from "vitest";
import { isAllowedNavigation, isExternalHttp, readNotice } from "./security.js";

describe("desktop navigation", () => {
  const origin = "http://127.0.0.1:3000";

  it("allows the app origin and the packaged error page only", () => {
    expect(isAllowedNavigation("http://127.0.0.1:3000/inbox", origin)).toBe(true);
    expect(isAllowedNavigation("http://127.0.0.1:3000/login?next=%2Finbox", origin)).toBe(true);
    expect(isAllowedNavigation("file:///C:/KeepX/static/offline.html", origin)).toBe(true);
    expect(isAllowedNavigation("https://example.com", origin)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", origin)).toBe(false);
    expect(isAllowedNavigation("file:///C:/Windows/system32/notepad.exe", origin)).toBe(false);
  });

  it("opens only http links outside the app", () => {
    expect(isExternalHttp("https://example.com/help")).toBe(true);
    expect(isExternalHttp("file:///C:/secret.txt")).toBe(false);
  });

  it("rejects a notice without a short title", () => {
    expect(readNotice({ title: "  Buy milk  ", body: "Due now" })).toEqual({ title: "Buy milk", body: "Due now" });
    expect(readNotice({ title: "Line\nbreak", body: "" })).toEqual({ title: "Line break", body: "" });
    expect(readNotice({ title: "   ", body: "x" })).toBeNull();
    expect(readNotice({ title: "a".repeat(121), body: "" })).toBeNull();
    expect(readNotice({ title: "ok", body: "b".repeat(501) })).toBeNull();
    expect(readNotice(null)).toBeNull();
  });
});
