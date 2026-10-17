import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("android package", () => {
  it("matches the checksum published in the download catalog", () => {
    const catalog = readFileSync(path.join(__dirname, "../../../packages/shared/src/catalog.ts"), "utf8");
    const apk = readFileSync(path.join(__dirname, "../../web/public/downloads/KeepX-0.1.0-android.apk"));
    const hash = createHash("sha256").update(apk).digest("hex");
    expect(apk.subarray(0, 2).toString("hex")).toBe("504b");
    expect(catalog).toContain(`sha256:${hash}`);
    expect(catalog).toContain('href: "/downloads/KeepX-0.1.0-android.apk"');
  });
});
