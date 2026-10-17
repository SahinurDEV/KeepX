import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { taskFromTab, taskFromTitle } from "../src/task.js";

test("builds a task from a tab without taking a non-http url", () => {
  assert.deepEqual(taskFromTab("  Notes  ", "https://example.com/a"), {
    title: "Notes",
    description: "https://example.com/a",
  });
  assert.equal(taskFromTab("", "chrome://settings").description, "");
  assert.equal(taskFromTitle("   "), null);
  assert.equal(taskFromTitle("Buy milk").title, "Buy milk");
});

test("published extension archives match the download catalog", () => {
  const catalog = readFileSync(new URL("../../../packages/shared/src/catalog.ts", import.meta.url), "utf8");
  const names = [
    "KeepX-0.1.0-chrome.zip",
    "KeepX-0.1.0-edge.zip",
    "KeepX-0.1.0-firefox.xpi",
    "KeepX-0.1.0-gmail.zip",
  ];
  for (const name of names) {
    const bytes = readFileSync(new URL(`../../web/public/downloads/${name}`, import.meta.url));
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.ok(catalog.includes(`sha256:${hash}`), name);
  }
});
