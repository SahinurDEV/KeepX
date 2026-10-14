import type { Express } from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

let mongo: MongoMemoryServer;
let app: Express;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.BCRYPT_COST = "4";
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  app = await createApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
});

async function register(email: string, name = "Ada Lovelace") {
  const agent = request.agent(app);
  const response = await agent.post("/api/v1/auth/register").send({
    name,
    email,
    password: "correct-horse",
    timeZone: "UTC",
  });
  expect(response.status).toBe(201);
  return agent;
}

describe("vela api", () => {
  it("reports health", async () => {
    const response = await request(app).get("/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.body.db).toBe("connected");
  });

  it("registers, rejects a duplicate, and keeps the password private", async () => {
    const agent = await register("ada@example.com");
    const me = await agent.get("/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("ada@example.com");
    expect(me.body.passwordHash).toBeUndefined();
    const duplicate = await request(app).post("/api/v1/auth/register").send({
      name: "Ada",
      email: "ada@example.com",
      password: "correct-horse",
    });
    expect(duplicate.status).toBe(409);
    expect((await request(app).get("/api/v1/me")).status).toBe(401);
  });

  it("does not reveal whether recovery email is sent", async () => {
    const response = await request(app).post("/api/v1/auth/recovery").send({ email: "ada@example.com" });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("EMAIL_NOT_CONFIGURED");
  });

  it("isolates tasks between accounts", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const created = await ada.post("/api/v1/tasks").send({ title: "Private note", priority: "high" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await grace.get("/api/v1/tasks")).body.tasks).toEqual([]);
    expect((await grace.get(`/api/v1/tasks/${id}`)).status).toBe(404);
    expect((await grace.patch(`/api/v1/tasks/${id}`).send({ title: "Stolen", revision: 0 })).status).toBe(404);
    expect((await grace.delete(`/api/v1/tasks/${id}`)).status).toBe(404);
  });

  it("creates, edits, completes, restores, searches, and filters tasks", async () => {
    const agent = await register("ada@example.com");
    const lists = await agent.get("/api/v1/lists");
    const inbox = lists.body.find((list: { isInbox: boolean }) => list.isInbox);
    const list = await agent.post("/api/v1/lists").send({ name: "Writing", color: "sea", icon: "book" });
    expect(list.status).toBe(201);
    const tag = await agent.post("/api/v1/tags").send({ name: "deep", color: "plum" });
    const key = "idem-key-001";
    const first = await agent
      .post("/api/v1/tasks")
      .set("Idempotency-Key", key)
      .send({
        title: "Draft chapter",
        listId: list.body.id,
        tagIds: [tag.body.id],
        priority: "high",
        dueAt: new Date().toISOString(),
        dueHasTime: false,
      });
    const replay = await agent
      .post("/api/v1/tasks")
      .set("Idempotency-Key", key)
      .send({
        title: "Draft chapter",
        listId: list.body.id,
        tagIds: [tag.body.id],
        priority: "high",
        dueAt: first.body.dueAt,
        dueHasTime: false,
      });
    expect(replay.body.id).toBe(first.body.id);
    const all = await agent.get("/api/v1/tasks").query({ view: "list", listId: list.body.id });
    expect(all.body.tasks).toHaveLength(1);
    const renamed = await agent.patch(`/api/v1/tasks/${first.body.id}`).send({ title: "Draft chapter two", revision: first.body.revision });
    expect(renamed.status).toBe(200);
    const stale = await agent.patch(`/api/v1/tasks/${first.body.id}`).send({ title: "Nope", revision: first.body.revision });
    expect(stale.status).toBe(409);
    const today = await agent.get("/api/v1/tasks").query({ view: "today" });
    expect(today.body.tasks.map((task: { title: string }) => task.title)).toContain("Draft chapter two");
    const found = await agent.get("/api/v1/tasks").query({ view: "search", q: "chapter" });
    expect(found.body.tasks).toHaveLength(1);
    const done = await agent.post(`/api/v1/tasks/${first.body.id}/complete`);
    expect(done.body.status).toBe("completed");
    const completed = await agent.get("/api/v1/tasks").query({ view: "completed" });
    expect(completed.body.tasks).toHaveLength(1);
    await agent.delete(`/api/v1/tasks/${first.body.id}`);
    expect((await agent.get("/api/v1/tasks").query({ view: "all" })).body.tasks).toHaveLength(0);
    const restored = await agent.post(`/api/v1/tasks/${first.body.id}/restore`);
    expect(restored.body.deletedAt).toBeNull();
    expect((await agent.delete(`/api/v1/lists/${inbox.id}`)).status).toBe(400);
    await agent.delete(`/api/v1/lists/${list.body.id}`);
    const moved = await agent.get(`/api/v1/tasks/${first.body.id}`);
    expect(moved.body.task.listId).toBe(inbox.id);
  });

  it("keeps recurrence history and schedules the next occurrence", async () => {
    const agent = await register("ada@example.com");
    const dueAt = new Date("2026-05-01T13:00:00.000Z").toISOString();
    const created = await agent.post("/api/v1/tasks").send({
      title: "Water plants",
      dueAt,
      dueHasTime: true,
      timeZone: "UTC",
      recurrence: { frequency: "daily", interval: 1, count: 2 },
      reminderOffsetMinutes: 0,
    });
    expect(created.status).toBe(201);
    const once = await agent.post(`/api/v1/tasks/${created.body.id}/complete`);
    expect(once.body.status).toBe("open");
    expect(once.body.dueAt).not.toBe(dueAt);
    const history = await agent.get("/api/v1/tasks").query({ view: "completed" });
    expect(history.body.occurrences).toHaveLength(1);
    expect(history.body.occurrences[0].action).toBe("completed");
    const finished = await agent.post(`/api/v1/tasks/${created.body.id}/complete`);
    expect(finished.body.status).toBe("completed");
    const pending = await agent.get("/api/v1/reminders/pending");
    expect(pending.body).toEqual([]);
  });

  it("delivers an in-app reminder once", async () => {
    const agent = await register("ada@example.com");
    const created = await agent.post("/api/v1/tasks").send({
      title: "Stand up",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    const pending = await agent.get("/api/v1/reminders/pending");
    expect(pending.body).toHaveLength(1);
    expect((await agent.post(`/api/v1/reminders/${pending.body[0].id}/ack`)).status).toBe(204);
    expect((await agent.get("/api/v1/reminders/pending")).body).toEqual([]);
    expect(created.body.reminderOffsetMinutes).toBe(0);
  });
});
