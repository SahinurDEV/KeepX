import { describe, expect, it } from "vitest";
import { createTaskSchema, registerSchema, updateTaskSchema } from "./schemas.js";

describe("schemas", () => {
  it("rejects a short password", () => {
    const result = registerSchema.safeParse({
      name: "Ada",
      email: "ada@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("requires a title and accepts a daily rule", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("requires a revision when updating", () => {
    expect(updateTaskSchema.safeParse({ title: "Renamed" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ title: "Renamed", revision: 2 }).success).toBe(true);
  });
});
