import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("windows package", () => {
  it("matches the checksum published in the download catalog", () => {
    const catalog = readFileSync(path.join(__dirname, "../../../packages/shared/src/catalog.ts"), "utf8");
    const exe = readFileSync(path.join(__dirname, "../../web/public/downloads/KeepX-0.1.0-win-x64.exe"));
    const hash = createHash("sha256").update(exe).digest("hex");
    expect(catalog).toContain(`sha256:${hash}`);
    expect(catalog).toContain('href: "/downloads/KeepX-0.1.0-win-x64.exe"');
    const linux = readFileSync(path.join(__dirname, "../../web/public/downloads/KeepX-0.1.0-linux-x64.AppImage"));
    const linuxHash = createHash("sha256").update(linux).digest("hex");
    expect(linux.subarray(0, 4).toString("hex")).toBe("7f454c46");
    expect(catalog).toContain(`sha256:${linuxHash}`);
  });
});
