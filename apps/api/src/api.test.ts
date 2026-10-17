import type { Express } from "express";
import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { createApp } from "./app.js";
import { assertCheckoutUrl } from "./billing.js";
import { getConfig } from "./config.js";
import type { MailMessage } from "./mailer.js";
import { List, Occurrence, PasswordReset, PushDevice, Reminder, Tag, Task, User } from "./models.js";
import { dispatchEmailReminders } from "./services/email-reminders.js";
import { dispatchPushReminders } from "./services/push-reminders.js";
import { ExpiredPushTokenError, createPushSender, type PushMessage, type PushSender } from "./push.js";

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

function dueTask(title: string) {
  return { title, dueAt: new Date().toISOString(), dueHasTime: true, reminderOffsetMinutes: 0 };
}

function browserSubscription(name: string): string {
  return JSON.stringify({
    endpoint: `https://push.example.test/${name}`,
    keys: { p256dh: "B".repeat(80), auth: "auth-key" },
  });
}

function billingEvent(type: string, object: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ type, data: { object } }));
}

function stripeSignature(payload: Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload.toString("utf8")}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function postWebhook(app: Express, payload: Buffer, secret: string) {
  return request(app)
    .post("/api/v1/billing/webhook")
    .set("stripe-signature", stripeSignature(payload, secret))
    .set("content-type", "application/json")
    .send(payload.toString("utf8"));
}

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
    await register("ada@example.com");
    const response = await request(app).post("/api/v1/auth/recovery").send({ email: "ada@example.com" });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("EMAIL_NOT_CONFIGURED");
    expect(await PasswordReset.countDocuments()).toBe(0);
    expect((await request(app).get("/api/v1/meta")).body.emailRecovery).toBe(false);
    expect((await request(app).get("/api/v1/meta")).body.notificationChannels).toEqual(["in_app"]);
    expect((await request(app).get("/api/v1/meta")).body.webPushPublicKey).toBeNull();
  });

  it("emails a reset link only when mail is configured and the account exists", async () => {
    const sent: MailMessage[] = [];
    const mailApp = await createApp({
      mailer: {
        async send(message) {
          sent.push(message);
        },
      },
    });
    const agent = request.agent(mailApp);
    const created = await agent.post("/api/v1/auth/register").send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    expect(created.status).toBe(201);
    expect((await request(mailApp).get("/api/v1/meta")).body.emailRecovery).toBe(true);

    const known = await request(mailApp).post("/api/v1/auth/recovery").send({ email: "Ada@example.com" });
    const unknown = await request(mailApp).post("/api/v1/auth/recovery").send({ email: "missing@example.com" });
    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ada@example.com");
    const token = new URL(sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "http://localhost/reset-password").searchParams.get("token");
    expect(token).toBeTruthy();

    const reset = await request(mailApp).post("/api/v1/auth/reset").send({ token, password: "new-password" });
    expect(reset.status).toBe(204);
    expect((await agent.get("/api/v1/me")).status).toBe(401);
    const oldPassword = await request(mailApp).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "correct-horse" });
    expect(oldPassword.status).toBe(401);
    const nextPassword = await request(mailApp).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "new-password" });
    expect(nextPassword.status).toBe(200);
    expect((await request(mailApp).post("/api/v1/auth/reset").send({ token, password: "another-pass" })).status).toBe(400);
    expect(await PasswordReset.countDocuments()).toBe(0);
  });

  it("drops a reset token when the mailer fails", async () => {
    const mailApp = await createApp({
      mailer: {
        async send() {
          throw new Error("smtp down");
        },
      },
    });
    await request(mailApp).post("/api/v1/auth/register").send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    const response = await request(mailApp).post("/api/v1/auth/recovery").send({ email: "ada@example.com" });
    expect(response.status).toBe(204);
    expect(await PasswordReset.countDocuments()).toBe(0);
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
    expect(stale.body.error.task.title).toBe("Draft chapter two");
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

  it("changes one occurrence without moving the rest of the series", async () => {
    const agent = await register("ada@example.com");
    const dueAt = new Date("2026-05-01T13:00:00.000Z").toISOString();
    const created = await agent.post("/api/v1/tasks").send({
      title: "Water plants",
      dueAt,
      dueHasTime: true,
      timeZone: "UTC",
      recurrence: { frequency: "daily", interval: 1 },
    });
    const moved = new Date("2026-05-01T18:00:00.000Z").toISOString();
    const once = await agent.patch(`/api/v1/tasks/${created.body.id}`).send({
      title: "Water the fern",
      dueAt: moved,
      dueHasTime: true,
      revision: created.body.revision,
      occurrenceScope: "this",
    });
    expect(once.status).toBe(200);
    expect(once.body.title).toBe("Water the fern");
    expect(once.body.occurrenceOriginalDueAt).toBe(dueAt);
    const rejected = await agent.patch(`/api/v1/tasks/${created.body.id}`).send({
      recurrence: { frequency: "weekly", interval: 1 },
      revision: once.body.revision,
      occurrenceScope: "this",
    });
    expect(rejected.status).toBe(400);
    const completed = await agent.post(`/api/v1/tasks/${created.body.id}/complete`);
    expect(completed.body.title).toBe("Water plants");
    expect(new Date(completed.body.dueAt).getTime()).toBe(new Date("2026-05-02T13:00:00.000Z").getTime());
    expect(completed.body.occurrenceOriginalDueAt).toBeNull();
    const restored = await agent.post(`/api/v1/tasks/${created.body.id}/uncomplete`);
    expect(restored.body.title).toBe("Water the fern");
    expect(new Date(restored.body.dueAt).getTime()).toBe(new Date(moved).getTime());
    expect(restored.body.occurrenceOriginalDueAt).toBe(dueAt);
  });

  it("drops one series date without counting it", async () => {
    const agent = await register("ada@example.com");
    const dueAt = new Date("2026-05-01T13:00:00.000Z").toISOString();
    const created = await agent.post("/api/v1/tasks").send({
      title: "Water plants",
      dueAt,
      dueHasTime: true,
      timeZone: "UTC",
      recurrence: { frequency: "daily", interval: 1, count: 3 },
    });
    const other = await register("grace@example.com");
    expect((await other.post(`/api/v1/tasks/${created.body.id}/omit`)).status).toBe(404);
    const omitted = await agent.post(`/api/v1/tasks/${created.body.id}/omit`);
    expect(omitted.status).toBe(200);
    expect(omitted.body.status).toBe("open");
    expect(new Date(omitted.body.dueAt).getTime()).toBe(new Date("2026-05-02T13:00:00.000Z").getTime());
    const history = await agent.get("/api/v1/tasks").query({ view: "completed" });
    expect(history.body.occurrences).toHaveLength(0);
    const next = await agent.post(`/api/v1/tasks/${created.body.id}/complete`);
    expect(next.body.status).toBe("open");
    expect(new Date(next.body.dueAt).getTime()).toBe(new Date("2026-05-03T13:00:00.000Z").getTime());
  });

  it("lets an extension token create a task and rejects other websites", async () => {
    const agent = await register("ada@example.com");
    const blocked = await request(app)
      .post("/api/v1/auth/tokens")
      .set("Origin", "https://mail.google.com")
      .send({ name: "Gmail" });
    expect(blocked.status).toBe(403);

    const created = await agent.post("/api/v1/auth/tokens").send({ name: "Chrome" });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(created.body.token).toMatch(/^kx_/);
    expect((await agent.get("/api/v1/auth/tokens")).body[0].token).toBeUndefined();

    const task = await request(app)
      .post("/api/v1/tasks")
      .set("Origin", "chrome-extension://abcdefghijklmnopqrstuvwxyz")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "From the extension" });
    expect(task.status).toBe(201);
    expect((await agent.get("/api/v1/tasks")).body.tasks.map((item: { title: string }) => item.title)).toContain("From the extension");
    expect((await agent.delete(`/api/v1/auth/tokens/${created.body.id}`)).status).toBe(204);
    const revoked = await request(app)
      .post("/api/v1/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Too late" });
    expect(revoked.status).toBe(401);
    const restored = await agent.post(`/api/v1/auth/tokens/${created.body.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ id: created.body.id, name: "Chrome" });
    const again = await request(app)
      .post("/api/v1/tasks")
      .set("Origin", "chrome-extension://abcdefghijklmnopqrstuvwxyz")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Back again" });
    expect(again.status).toBe(201);
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
    const reminderId = pending.body[0].id as string;
    expect((await agent.post(`/api/v1/reminders/${reminderId}/ack`)).status).toBe(204);
    expect((await agent.get("/api/v1/reminders/pending")).body).toEqual([]);
    expect((await agent.post(`/api/v1/reminders/${reminderId}/unack`)).status).toBe(204);
    expect((await agent.get("/api/v1/reminders/pending")).body).toHaveLength(1);
    expect((await agent.post(`/api/v1/reminders/${reminderId}/unack`)).status).toBe(400);
    expect(created.body.reminderOffsetMinutes).toBe(0);
  });

  it("emails a due reminder once when the account asks for it", async () => {
    const sent: MailMessage[] = [];
    const mailer = {
      async send(message: MailMessage) {
        sent.push(message);
      },
    };
    const mailApp = await createApp({ mailer });
    expect((await request(mailApp).get("/api/v1/meta")).body.notificationChannels).toEqual(["in_app", "email"]);
    const agent = request.agent(mailApp);
    const registered = await agent.post("/api/v1/auth/register").send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    expect(registered.body.emailReminders).toBe(false);
    const quiet = await agent.post("/api/v1/tasks").send({
      title: "Stand up",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    await dispatchEmailReminders(mailer, { appOrigin: "http://127.0.0.1:3000" });
    expect(sent).toHaveLength(0);
    expect((await Reminder.findOne({ taskId: quiet.body.id }))?.emailStatus).toBe("skipped");

    expect((await agent.patch("/api/v1/me").send({ emailReminders: true })).body.emailReminders).toBe(true);
    const unconfigured = await agent.post("/api/v1/tasks").send({
      title: "No mail server",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    await dispatchEmailReminders(null, { appOrigin: "http://127.0.0.1:3000" });
    expect((await Reminder.findOne({ taskId: unconfigured.body.id }))?.emailStatus).toBe("missed");

    const due = await agent.post("/api/v1/tasks").send({
      title: "Call home",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    await dispatchEmailReminders(mailer, { appOrigin: "http://127.0.0.1:3000" });
    expect(sent.map((message) => message.subject)).toEqual(["Reminder: Call home"]);
    expect(sent[0]?.to).toBe("ada@example.com");
    expect(sent[0]?.text).toContain("http://127.0.0.1:3000");
    await dispatchEmailReminders(mailer, { appOrigin: "http://127.0.0.1:3000" });
    expect(sent).toHaveLength(1);
    expect((await Reminder.findOne({ taskId: due.body.id }))?.emailStatus).toBe("sent");

    const late = await agent.post("/api/v1/tasks").send({
      title: "Too late",
      dueAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    await dispatchEmailReminders(mailer, { appOrigin: "http://127.0.0.1:3000" });
    expect(sent).toHaveLength(1);
    expect((await Reminder.findOne({ taskId: late.body.id }))?.emailStatus).toBe("missed");

    const broken = await agent.post("/api/v1/tasks").send({
      title: "Broken mail",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    await dispatchEmailReminders({
      async send() {
        throw new Error("smtp down");
      },
    });
    expect((await Reminder.findOne({ taskId: broken.body.id }))?.emailStatus).toBe("failed");
    expect(sent).toHaveLength(1);
  });

  it("sends one push notification when the account asks for it", async () => {
    const sent: PushMessage[] = [];
    const push: PushSender = {
      webPushPublicKey: "B".repeat(87),
      canSend: (provider) => provider === "web" || provider === "expo",
      async send(message) {
        sent.push(message);
      },
    };
    const pushApp = await createApp({ push });
    const meta = await request(pushApp).get("/api/v1/meta");
    expect(meta.body.notificationChannels).toEqual(["in_app", "web_push", "expo_push"]);
    expect(meta.body.webPushPublicKey).toBe("B".repeat(87));
    expect((await request(pushApp).post("/api/v1/devices").send({ platform: "web", token: browserSubscription("one") })).status).toBe(401);

    const agent = request.agent(pushApp);
    const registered = await agent.post("/api/v1/auth/register").send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    expect(registered.body.pushReminders).toBe(false);
    const quiet = await agent.post("/api/v1/tasks").send(dueTask("Stand up"));
    await dispatchPushReminders(push);
    expect(sent).toHaveLength(0);
    expect((await Reminder.findOne({ taskId: quiet.body.id }))?.pushStatus).toBe("skipped");

    expect((await agent.patch("/api/v1/me").send({ pushReminders: true })).body.pushReminders).toBe(true);
    const nowhere = await agent.post("/api/v1/tasks").send(dueTask("No device"));
    await dispatchPushReminders(push);
    expect((await Reminder.findOne({ taskId: nowhere.body.id }))?.pushStatus).toBe("missed");
    const unconfigured = await agent.post("/api/v1/tasks").send(dueTask("No provider"));
    await dispatchPushReminders(null);
    expect((await Reminder.findOne({ taskId: unconfigured.body.id }))?.pushStatus).toBe("missed");

    expect((await agent.post("/api/v1/devices").send({ platform: "web", token: "not-a-subscription" })).status).toBe(400);
    const subscription = browserSubscription("ada");
    const created = await agent.post("/api/v1/devices").send({ platform: "web", token: subscription });
    expect(created.status).toBe(201);
    expect(created.body.token).toBeUndefined();
    expect(created.body.platform).toBe("web");
    const grace = request.agent(pushApp);
    await grace.post("/api/v1/auth/register").send({
      name: "Grace Hopper",
      email: "grace@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    expect((await grace.post("/api/v1/devices").send({ platform: "web", token: subscription })).status).toBe(409);
    expect((await grace.delete(`/api/v1/devices/${created.body.id}`)).status).toBe(404);

    const due = await agent.post("/api/v1/tasks").send(dueTask("Call home"));
    const pending = await agent.get("/api/v1/reminders/pending");
    const callHome = pending.body.find((item: { title: string; id: string }) => item.title === "Call home");
    expect((await agent.post(`/api/v1/reminders/${callHome.id}/ack`)).status).toBe(204);
    await dispatchPushReminders(push);
    expect(sent.map((message) => message.title)).toEqual(["Reminder: Call home"]);
    expect(sent[0]?.provider).toBe("web");
    expect(sent[0]?.token).toBe(subscription);
    await dispatchPushReminders(push);
    expect(sent).toHaveLength(1);
    expect((await Reminder.findOne({ taskId: due.body.id }))?.pushStatus).toBe("sent");

    const late = await agent.post("/api/v1/tasks").send({
      title: "Too late",
      dueAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    await dispatchPushReminders(push);
    expect(sent).toHaveLength(1);
    expect((await Reminder.findOne({ taskId: late.body.id }))?.pushStatus).toBe("missed");

    const broken = await agent.post("/api/v1/tasks").send(dueTask("Broken push"));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    await dispatchPushReminders({
      webPushPublicKey: null,
      canSend: () => true,
      async send() {
        throw new Error(`smtp down ${subscription}`);
      },
    });
    spy.mockRestore();
    expect((await Reminder.findOne({ taskId: broken.body.id }))?.pushStatus).toBe("failed");
    expect(errors.join("\n")).toContain("reminder_push_failed");
    expect(errors.join("\n")).not.toContain(subscription);

    const stale = await agent.post("/api/v1/tasks").send(dueTask("Old browser"));
    await dispatchPushReminders({
      webPushPublicKey: null,
      canSend: () => true,
      async send() {
        throw new ExpiredPushTokenError();
      },
    });
    expect((await Reminder.findOne({ taskId: stale.body.id }))?.pushStatus).toBe("skipped");
    expect(await PushDevice.countDocuments({ userId: registered.body.id })).toBe(0);

    for (let index = 0; index < 10; index += 1) {
      const response = await agent.post("/api/v1/devices").send({ platform: "android", token: `ExponentPushToken[${"a".repeat(8)}${index}]` });
      expect(response.status).toBe(201);
    }
    expect((await agent.post("/api/v1/devices").send({ platform: "ios", token: "ExponentPushToken[bbbbbbbb]" })).status).toBe(400);

    expect(createPushSender(getConfig())).toBeNull();
    process.env.VAPID_PUBLIC_KEY = "a".repeat(87);
    try {
      expect(() => getConfig()).toThrow(/VAPID_PUBLIC_KEY/);
    } finally {
      delete process.env.VAPID_PUBLIC_KEY;
    }
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = "mailto:keepx@example.com";
    try {
      const sender = createPushSender(getConfig());
      expect(sender?.canSend("web")).toBe(true);
      expect(sender?.canSend("expo")).toBe(false);
      expect(sender?.webPushPublicKey).toBe(keys.publicKey);
    } finally {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_SUBJECT;
    }
  });

  it("shares a list with another account and keeps private tasks hidden", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const lists = await ada.get("/api/v1/lists");
    const inbox = lists.body.find((list: { isInbox: boolean }) => list.isInbox);
    const created = await ada.post("/api/v1/lists").send({ name: "Trip" });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("owner");
    const sharedTask = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: created.body.id });
    const privateTask = await ada.post("/api/v1/tasks").send({ title: "Secret" });
    expect((await grace.get(`/api/v1/tasks/${sharedTask.body.id}`)).status).toBe(404);
    expect((await ada.post(`/api/v1/lists/${inbox.id}/members`).send({ email: "grace@example.com" })).status).toBe(400);
    expect((await ada.post(`/api/v1/lists/${created.body.id}/members`).send({ email: "nobody@example.com" })).status).toBe(404);

    const invited = await ada.post(`/api/v1/lists/${created.body.id}/members`).send({ email: "grace@example.com" });
    expect(invited.status).toBe(201);
    expect(invited.body.email).toBe("grace@example.com");
    const graceLists = await grace.get("/api/v1/lists");
    expect(graceLists.body.find((list: { id: string }) => list.id === created.body.id).role).toBe("editor");
    const visible = await grace.get("/api/v1/tasks").query({ view: "list", listId: created.body.id });
    expect(visible.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Pack"]);
    expect((await grace.get(`/api/v1/tasks/${privateTask.body.id}`)).status).toBe(404);

    const added = await grace.post("/api/v1/tasks").send({ title: "Tickets", listId: created.body.id });
    expect(added.status).toBe(201);
    const both = await ada.get("/api/v1/tasks").query({ view: "list", listId: created.body.id });
    expect(both.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Pack", "Tickets"]);
    expect((await grace.delete(`/api/v1/lists/${created.body.id}`)).status).toBe(403);

    expect((await ada.delete(`/api/v1/lists/${created.body.id}/members/${invited.body.id}`)).status).toBe(204);
    expect((await grace.get(`/api/v1/tasks/${sharedTask.body.id}`)).status).toBe(404);
    expect((await ada.get(`/api/v1/tasks/${sharedTask.body.id}`)).status).toBe(200);
  });

  it("keeps the free plan until a signed billing notice arrives", async () => {
    expect((await request(app).get("/api/v1/meta")).body.billing).toBe(false);
    expect((await request(app).post("/api/v1/billing/checkout")).status).toBe(401);
    const plain = await register("ada@example.com");
    expect((await plain.get("/api/v1/me")).body.plan).toBe("personal");
    expect((await plain.patch("/api/v1/me").send({ name: "Ada Lovelace", plan: "plus" })).body.plan).toBe("personal");
    expect((await plain.post("/api/v1/billing/checkout")).status).toBe(503);
    expect((await plain.get("/api/v1/billing")).body).toMatchObject({ plan: "personal", billing: false, features: { tasks: true } });
    expect((await request(app).post("/api/v1/billing/webhook").set("content-type", "application/json").send("{}")).status).toBe(503);

    const calls: { userId: string; email: string; successUrl: string }[] = [];
    const secret = "whsec_testsecret";
    const billingApp = await createApp({
      billing: {
        webhookSecret: secret,
        client: {
          async createCheckout(input) {
            calls.push({ userId: input.userId, email: input.email, successUrl: input.successUrl });
            return "https://checkout.stripe.com/c/pay/cs_test";
          },
        },
      },
    });
    expect((await request(billingApp).get("/api/v1/meta")).body.billing).toBe(true);
    const agent = request.agent(billingApp);
    const registered = await agent.post("/api/v1/auth/register").send({
      name: "Ada Lovelace",
      email: "bill@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    const checkout = await agent.post("/api/v1/billing/checkout");
    expect(checkout.status).toBe(200);
    expect(checkout.body.url).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(calls[0]).toMatchObject({ userId: registered.body.id, email: "bill@example.com" });
    expect(calls[0]?.successUrl).toBe("http://localhost:3000/settings?billing=return");
    expect((await agent.get("/api/v1/me")).body.plan).toBe("personal");

    const paid = billingEvent("checkout.session.completed", {
      client_reference_id: registered.body.id,
      customer: "cus_test",
      subscription: "sub_test",
      payment_status: "paid",
    });
    expect((await request(billingApp).post("/api/v1/billing/webhook").set("content-type", "application/json").send(paid)).status).toBe(400);
    expect((await agent.get("/api/v1/me")).body.plan).toBe("personal");
    const forged = stripeSignature(paid, "whsec_other");
    expect(
      (await request(billingApp).post("/api/v1/billing/webhook").set("stripe-signature", forged).set("content-type", "application/json").send(paid)).status,
    ).toBe(400);
    const stale = stripeSignature(paid, secret, Math.floor(Date.now() / 1000) - 600);
    expect(
      (await request(billingApp).post("/api/v1/billing/webhook").set("stripe-signature", stale).set("content-type", "application/json").send(paid)).status,
    ).toBe(400);
    expect((await agent.get("/api/v1/me")).body.plan).toBe("personal");

    const unpaid = billingEvent("checkout.session.completed", {
      client_reference_id: registered.body.id,
      customer: "cus_test",
      subscription: "sub_test",
      payment_status: "unpaid",
    });
    expect((await postWebhook(billingApp, unpaid, secret)).status).toBe(204);
    expect((await agent.get("/api/v1/me")).body.plan).toBe("personal");

    expect((await postWebhook(billingApp, paid, secret)).status).toBe(204);
    const entitled = await agent.get("/api/v1/billing");
    expect(entitled.body.plan).toBe("plus");
    expect(entitled.body.billing).toBe(true);
    expect(entitled.body.features).toEqual({ tasks: true, sharing: true, emailReminders: true, pushReminders: true });
    expect(entitled.body.stripeCustomerId).toBeUndefined();

    const removed = billingEvent("customer.subscription.deleted", { id: "sub_test" });
    expect((await postWebhook(billingApp, removed, secret)).status).toBe(204);
    expect((await agent.get("/api/v1/me")).body.plan).toBe("personal");

    const missing = billingEvent("checkout.session.completed", {
      client_reference_id: "a".repeat(24),
      customer: "cus_missing",
      subscription: "sub_missing",
      payment_status: "paid",
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    expect((await postWebhook(billingApp, missing, secret)).status).toBe(204);
    spy.mockRestore();
    expect(errors.join("\n")).toContain("billing_account_missing");
    expect(errors.join("\n")).not.toContain("bill@example.com");

    const failing = await createApp({
      billing: {
        webhookSecret: secret,
        client: {
          async createCheckout() {
            throw new Error("sk_test_secret");
          },
        },
      },
    });
    const payer = request.agent(failing);
    await payer.post("/api/v1/auth/register").send({
      name: "Grace Hopper",
      email: "grace@example.com",
      password: "correct-horse",
      timeZone: "UTC",
    });
    const failure = await payer.post("/api/v1/billing/checkout");
    expect(failure.status).toBe(502);
    expect(JSON.stringify(failure.body)).not.toContain("sk_test_secret");

    expect(() => assertCheckoutUrl("http://checkout.stripe.com/c/pay")).toThrow(/rejected/);
    expect(() => assertCheckoutUrl("https://evil.example/pay")).toThrow(/rejected/);
    expect(assertCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test")).toContain("checkout.stripe.com");

    process.env.STRIPE_SECRET_KEY = "sk_test_abc1234567890";
    try {
      expect(() => getConfig()).toThrow(/STRIPE_SECRET_KEY/);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it("exports the account archive without another account's private tasks", async () => {
    expect((await request(app).get("/api/v1/export")).status).toBe(401);
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const list = await ada.post("/api/v1/lists").send({ name: "Trip" });
    expect((await ada.post("/api/v1/tags").send({ name: "Travel" })).status).toBe(201);
    await ada.post("/api/v1/tasks").send({ title: "Pack", listId: list.body.id });
    await ada.post("/api/v1/tasks").send({ title: "Mine" });
    const gone = await ada.post("/api/v1/tasks").send({ title: "Gone" });
    expect((await ada.delete(`/api/v1/tasks/${gone.body.id}`)).status).toBe(200);
    await grace.post("/api/v1/tasks").send({ title: "Secret" });
    const repeating = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect((await ada.post(`/api/v1/tasks/${repeating.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/lists/${list.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await grace.post("/api/v1/tasks").send({ title: "Tickets", listId: list.body.id })).status).toBe(201);

    const exported = await ada.get("/api/v1/export");
    expect(exported.status).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("keepx-export.json");
    expect(exported.body.account).toMatchObject({ email: "ada@example.com", plan: "personal" });
    expect(exported.body.truncated).toBe(false);
    expect(exported.body.passwordHash).toBeUndefined();
    expect(JSON.stringify(exported.body)).not.toContain("correct-horse");
    expect(exported.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Gone", "Mine", "Pack", "Tickets", "Water"]);
    expect(exported.body.tasks.find((task: { title: string; deletedAt: string | null }) => task.title === "Gone").deletedAt).toEqual(expect.any(String));
    expect(exported.body.tags.map((tag: { name: string }) => tag.name)).toContain("Travel");
    const trip = exported.body.lists.find((item: { name: string }) => item.name === "Trip");
    expect(trip.role).toBe("owner");
    expect(trip.members.map((member: { email: string }) => member.email).sort()).toEqual(["ada@example.com", "grace@example.com"]);
    expect(exported.body.occurrences.map((row: { title: string }) => row.title)).toContain("Water");

    const graceExport = await grace.get("/api/v1/export");
    const graceTitles = graceExport.body.tasks.map((task: { title: string }) => task.title);
    expect(graceTitles).toEqual(expect.arrayContaining(["Pack", "Secret", "Tickets"]));
    expect(graceTitles).not.toContain("Mine");
    expect(graceTitles).not.toContain("Gone");
    expect(graceTitles).not.toContain("Water");
  });

  it("imports an export as a copy and ignores plan and sharing", async () => {
    expect((await request(app).post("/api/v1/import").send({})).status).toBe(401);
    const ada = await register("ada@example.com");
    const nia = await register("nia@example.com", "Nia");
    const list = await ada.post("/api/v1/lists").send({ name: "Trip" });
    expect((await ada.post("/api/v1/tags").send({ name: "Travel" })).status).toBe(201);
    const tagId = (await ada.get("/api/v1/export")).body.tags[0].id as string;
    await ada.post("/api/v1/tasks").send({ title: "Pack", listId: list.body.id, tagIds: [tagId] });
    const gone = await ada.post("/api/v1/tasks").send({ title: "Gone" });
    expect((await ada.delete(`/api/v1/tasks/${gone.body.id}`)).status).toBe(200);
    const repeating = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect((await ada.post(`/api/v1/tasks/${repeating.body.id}/complete`)).status).toBe(200);
    const exported = await ada.get("/api/v1/export");
    const broken = structuredClone(exported.body);
    broken.tasks[0].listId = "000000000000000000000000";
    expect((await nia.post("/api/v1/import").send(broken)).status).toBe(400);
    expect((await nia.get("/api/v1/tasks")).body.tasks).toEqual([]);

    exported.body.account.plan = "plus";
    const imported = await nia.post("/api/v1/import").send(exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ lists: 1, tags: 1, tasks: 3, occurrences: 1 });
    expect(imported.body.listIds).toHaveLength(1);
    expect(imported.body.tagIds).toHaveLength(1);
    expect(imported.body.taskIds).toHaveLength(3);
    expect((await nia.get("/api/v1/me")).body.plan).toBe("personal");
    const copy = await nia.get("/api/v1/export");
    expect(copy.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Gone", "Pack", "Water"]);
    expect(copy.body.tasks.find((task: { title: string; deletedAt: string | null }) => task.title === "Gone").deletedAt).toEqual(expect.any(String));
    const water = copy.body.tasks.find((task: { title: string; id: string }) => task.title === "Water");
    expect(water.id).not.toBe(repeating.body.id);
    expect(copy.body.occurrences.find((row: { title: string; taskId: string }) => row.title === "Water").taskId).toBe(water.id);
    const trip = copy.body.lists.find((item: { name: string; members: { email: string }[] }) => item.name === "Trip");
    expect(trip.members.map((member: { email: string }) => member.email)).toEqual(["nia@example.com"]);
    expect(copy.body.lists.filter((item: { isInbox: boolean }) => item.isInbox)).toHaveLength(1);
    expect((await ada.get("/api/v1/tasks")).body.tasks.map((task: { title: string }) => task.title)).toContain("Pack");

    const reverted = await nia.post("/api/v1/import/revert").send({
      listIds: imported.body.listIds,
      tagIds: imported.body.tagIds,
      taskIds: imported.body.taskIds,
    });
    expect(reverted.status).toBe(200);
    expect(reverted.body).toMatchObject({ lists: 1, tags: 1, tasks: 3 });
    expect((await nia.get("/api/v1/lists")).body.filter((item: { isInbox: boolean }) => !item.isInbox)).toHaveLength(0);
    expect((await nia.get("/api/v1/tags")).body).toHaveLength(0);
    expect((await nia.get("/api/v1/tasks?view=all")).body.tasks).toHaveLength(0);
    expect((await nia.get("/api/v1/tasks?view=trash")).body.tasks).toHaveLength(0);
  });

  it("deletes the account and leaves other people's tasks in their inbox", async () => {
    expect((await request(app).delete("/api/v1/me").send({ password: "correct-horse" })).status).toBe(401);
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const list = await ada.post("/api/v1/lists").send({ name: "Trip" });
    await ada.post("/api/v1/tasks").send({ title: "Pack", listId: list.body.id });
    await ada.post("/api/v1/tasks").send({ title: "Mine" });
    expect((await ada.post(`/api/v1/lists/${list.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await grace.post("/api/v1/tasks").send({ title: "Tickets", listId: list.body.id })).status).toBe(201);
    await grace.post("/api/v1/tasks").send({ title: "Secret" });

    expect((await ada.delete("/api/v1/me").send({ password: "wrong-password" })).status).toBe(400);
    expect((await ada.get("/api/v1/me")).status).toBe(200);

    const adaUser = await User.findOne({ email: "ada@example.com" });
    if (!adaUser) throw new Error("missing account");
    adaUser.stripeSubscriptionId = "sub_test";
    await adaUser.save();
    expect((await ada.delete("/api/v1/me").send({ password: "correct-horse" })).status).toBe(409);
    adaUser.stripeSubscriptionId = null;
    await adaUser.save();

    expect((await ada.delete("/api/v1/me").send({ password: "correct-horse" })).status).toBe(204);
    expect((await ada.get("/api/v1/me")).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "correct-horse" })).status).toBe(401);
    expect(await User.countDocuments({ email: "ada@example.com" })).toBe(0);
    expect(await Task.countDocuments({ title: "Pack" })).toBe(0);
    expect(await List.countDocuments({ name: "Trip" })).toBe(0);

    const graceTasks = await grace.get("/api/v1/tasks?view=all");
    const titles = graceTasks.body.tasks.map((task: { title: string }) => task.title);
    expect(titles).toContain("Tickets");
    expect(titles).toContain("Secret");
    expect(titles).not.toContain("Pack");
    expect(titles).not.toContain("Mine");
    const inbox = (await grace.get("/api/v1/lists")).body.find((item: { isInbox: boolean }) => item.isInbox);
    expect(graceTasks.body.tasks.find((task: { title: string; listId: string }) => task.title === "Tickets").listId).toBe(inbox.id);
  });

  it("keeps deleted tasks in trash until restore or a permanent delete by the author", async () => {
    expect((await request(app).get("/api/v1/tasks?view=trash")).status).toBe(401);
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const list = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: list.body.id });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", parentId: pack.body.id, listId: list.body.id });
    expect(bottle.status).toBe(201);
    expect((await ada.post(`/api/v1/lists/${list.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const tickets = await grace.post("/api/v1/tasks").send({ title: "Tickets", listId: list.body.id });
    expect((await ada.delete(`/api/v1/tasks/${pack.body.id}`)).status).toBe(200);
    expect((await ada.delete(`/api/v1/tasks/${tickets.body.id}`)).status).toBe(200);

    const adaTrash = await ada.get("/api/v1/tasks?view=trash");
    expect(adaTrash.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Bottle", "Pack", "Tickets"]);
    const open = await ada.get("/api/v1/tasks?view=all");
    expect(open.body.tasks.map((task: { title: string }) => task.title)).not.toContain("Pack");
    const graceTrash = await grace.get("/api/v1/tasks?view=trash");
    expect(graceTrash.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Bottle", "Pack", "Tickets"]);

    expect((await ada.post(`/api/v1/tasks/${tickets.body.id}/purge`)).status).toBe(403);
    const mixed = await ada.post("/api/v1/tasks/purge").send({ ids: [pack.body.id, tickets.body.id] });
    expect(mixed.status).toBe(200);
    expect(mixed.body.purged).toBe(2);
    expect(mixed.body.kept).toBe(1);
    expect(mixed.body.deletedIds.sort()).toEqual([bottle.body.id, pack.body.id].sort());
    expect((await ada.get("/api/v1/tasks?view=trash")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Tickets"]);
    expect((await grace.post(`/api/v1/tasks/${tickets.body.id}/purge`)).status).toBe(200);
    expect((await grace.get("/api/v1/tasks?view=trash")).body.tasks.map((task: { title: string }) => task.title)).not.toContain("Tickets");
    expect((await request(app).post("/api/v1/tasks/purge").send({ ids: [pack.body.id] })).status).toBe(401);

    const bag = await ada.post("/api/v1/tasks").send({ title: "Bag", listId: list.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", parentId: bag.body.id, listId: list.body.id });
    expect((await ada.delete(`/api/v1/tasks/${bag.body.id}`)).status).toBe(200);
    const restored = await ada.post(`/api/v1/tasks/${bag.body.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.deletedAt).toBeNull();
    const afterRestore = await ada.get("/api/v1/tasks?view=trash");
    expect(afterRestore.body.tasks).toEqual([]);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task).toMatchObject({ deletedAt: null, parentId: bag.body.id });
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/purge`)).status).toBe(404);
    expect(await Task.countDocuments({ title: "Socks" })).toBe(1);
    expect((await ada.get("/api/v1/tasks?view=all")).body.tasks.map((task: { title: string }) => task.title)).toContain("Bag");

    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: list.body.id });
    const pegs = await ada.post("/api/v1/tasks").send({ title: "Pegs", parentId: tent.body.id, listId: list.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: list.body.id });
    expect((await ada.delete(`/api/v1/tasks/${tent.body.id}`)).status).toBe(200);
    expect((await ada.delete(`/api/v1/tasks/${lamp.body.id}`)).status).toBe(200);
    const batch = await ada.post("/api/v1/tasks/restore").send({ ids: [tent.body.id, pegs.body.id, lamp.body.id] });
    expect(batch.status).toBe(200);
    expect(batch.body.restored).toBe(2);
    expect(batch.body.skipped).toBe(0);
    expect(batch.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Lamp", "Tent"]);
    expect((await ada.get(`/api/v1/tasks/${pegs.body.id}`)).body.task).toMatchObject({ deletedAt: null, parentId: tent.body.id });
    const again = await ada.post("/api/v1/tasks/restore").send({ ids: [tent.body.id, lamp.body.id] });
    expect(again.status).toBe(200);
    expect(again.body.restored).toBe(0);
    expect(again.body.skipped).toBe(2);
    expect((await ada.post("/api/v1/tasks/restore").send({ ids: ["000000000000000000000000"] })).status).toBe(404);
    expect((await request(app).post("/api/v1/tasks/restore").send({ ids: [tent.body.id] })).status).toBe(401);
  });

  it("changes the password and can restore the previous one for a short window", async () => {
    const ada = await register("ada@example.com");
    expect(
      (
        await ada.post("/api/v1/auth/password").send({
          currentPassword: "correct-horse",
          newPassword: "fresh-password",
        })
      ).status,
    ).toBe(204);
    expect((await request(app).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "correct-horse" })).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "fresh-password" })).status).toBe(200);
    expect((await ada.post("/api/v1/auth/password/restore")).status).toBe(204);
    expect((await request(app).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "fresh-password" })).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/login").send({ email: "ada@example.com", password: "correct-horse" })).status).toBe(200);
    expect((await ada.post("/api/v1/auth/password/restore")).status).toBe(404);
  });

  it("lists password sessions and signs one browser out", async () => {
    expect((await request(app).get("/api/v1/auth/sessions")).status).toBe(401);
    const ada = await register("ada@example.com");
    const other = request.agent(app);
    expect(
      (
        await other
          .post("/api/v1/auth/login")
          .set("User-Agent", "Other-Browser")
          .send({ email: "ada@example.com", password: "correct-horse" })
      ).status,
    ).toBe(200);
    const sessions = await ada.get("/api/v1/auth/sessions");
    expect(sessions.status).toBe(200);
    expect(sessions.body).toHaveLength(2);
    expect(sessions.body.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    expect(JSON.stringify(sessions.body)).not.toContain("tokenHash");
    const otherSession = sessions.body.find((row: { current: boolean; userAgent: string }) => row.userAgent === "Other-Browser");
    expect(otherSession.current).toBe(false);
    const grace = await register("grace@example.com", "Grace Hopper");
    expect((await grace.delete(`/api/v1/auth/sessions/${otherSession.id}`)).status).toBe(404);
    expect((await other.get("/api/v1/me")).status).toBe(200);
    expect((await ada.delete(`/api/v1/auth/sessions/${otherSession.id}`)).status).toBe(204);
    expect((await other.get("/api/v1/me")).status).toBe(401);
    expect((await ada.get("/api/v1/auth/sessions")).body).toHaveLength(1);
    const restored = await ada.post(`/api/v1/auth/sessions/${otherSession.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ id: otherSession.id, current: false, userAgent: "Other-Browser" });
    expect((await other.get("/api/v1/me")).status).toBe(200);
    expect((await ada.get("/api/v1/auth/sessions")).body).toHaveLength(2);
    expect((await ada.delete(`/api/v1/auth/sessions/${otherSession.id}`)).status).toBe(204);
    const current = (await ada.get("/api/v1/auth/sessions")).body.find((row: { current: boolean }) => row.current);
    expect((await ada.delete(`/api/v1/auth/sessions/${current.id}`)).status).toBe(204);
    expect((await ada.get("/api/v1/me")).status).toBe(401);
  });

  it("duplicates a task without its history and drops tags the caller does not own", async () => {
    expect((await request(app).post("/api/v1/tasks/000000000000000000000001/duplicate")).status).toBe(401);
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const list = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tag = await ada.post("/api/v1/tags").send({ name: "Travel" });
    const pack = await ada.post("/api/v1/tasks").send({
      title: "Pack",
      description: "Clothes",
      listId: list.body.id,
      tagIds: [tag.body.id],
      priority: "high",
      dueAt: new Date().toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 15,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", parentId: pack.body.id, listId: list.body.id });
    const old = await ada.post("/api/v1/tasks").send({ title: "Old", parentId: pack.body.id, listId: list.body.id });
    expect((await ada.delete(`/api/v1/tasks/${old.body.id}`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/complete`)).status).toBe(200);
    expect((await grace.post(`/api/v1/tasks/${pack.body.id}/duplicate`)).status).toBe(404);

    expect((await ada.post(`/api/v1/lists/${list.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const copied = await grace.post(`/api/v1/tasks/${pack.body.id}/duplicate`);
    expect(copied.status).toBe(201);
    expect(copied.body.id).not.toBe(pack.body.id);
    expect(copied.body).toMatchObject({ title: "Pack", description: "Clothes", status: "open", priority: "high", tagIds: [], listId: list.body.id });
    expect(copied.body.recurrence).toMatchObject({ frequency: "daily", interval: 1 });
    expect(copied.body.completedAt).toBeNull();
    const detail = await grace.get(`/api/v1/tasks/${copied.body.id}`);
    expect(detail.body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Bottle"]);
    expect(await Occurrence.countDocuments({ taskId: copied.body.id })).toBe(0);
    expect(await Occurrence.countDocuments({ taskId: pack.body.id })).toBe(1);

    const own = await ada.post(`/api/v1/tasks/${pack.body.id}/duplicate`);
    expect(own.status).toBe(201);
    expect(own.body.tagIds).toEqual([tag.body.id]);
    expect((await ada.get(`/api/v1/tasks/${bottle.body.id}`)).status).toBe(200);
  });

  it("empties trash for the caller and leaves someone else's deleted task", async () => {
    expect((await request(app).post("/api/v1/tasks/empty-trash")).status).toBe(401);
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const list = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: list.body.id });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", parentId: pack.body.id, listId: list.body.id });
    expect(bottle.status).toBe(201);
    const mine = await ada.post("/api/v1/tasks").send({ title: "Mine" });
    expect((await ada.post(`/api/v1/lists/${list.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const tickets = await grace.post("/api/v1/tasks").send({ title: "Tickets", listId: list.body.id });
    expect((await ada.delete(`/api/v1/tasks/${pack.body.id}`)).status).toBe(200);
    expect((await ada.delete(`/api/v1/tasks/${mine.body.id}`)).status).toBe(200);
    expect((await ada.delete(`/api/v1/tasks/${tickets.body.id}`)).status).toBe(200);

    const emptied = await ada.post("/api/v1/tasks/empty-trash");
    expect(emptied.status).toBe(200);
    expect(emptied.body.purged).toBe(3);
    expect(emptied.body.kept).toBe(1);
    expect(emptied.body.deletedIds.sort()).toEqual([pack.body.id, bottle.body.id, mine.body.id].sort());
    expect((await ada.get("/api/v1/tasks?view=trash")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Tickets"]);
    expect(await Task.countDocuments({ title: { $in: ["Pack", "Bottle", "Mine"] } })).toBe(0);

    const brought = await ada.post("/api/v1/tasks/purge/restore").send({ ids: emptied.body.deletedIds });
    expect(brought.status).toBe(200);
    expect(brought.body).toEqual({ restored: 3 });
    expect(
      (await ada.get("/api/v1/tasks?view=trash")).body.tasks.map((task: { title: string }) => task.title).sort(),
    ).toEqual(["Bottle", "Mine", "Pack", "Tickets"]);

    const emptiedAgain = await ada.post("/api/v1/tasks/empty-trash");
    expect(emptiedAgain.body.purged).toBe(3);
    expect(emptiedAgain.body.kept).toBe(1);

    const graceEmpty = await grace.post("/api/v1/tasks/empty-trash");
    expect(graceEmpty.body).toEqual({ purged: 1, kept: 0, deletedIds: [tickets.body.id] });
    expect((await ada.get("/api/v1/tasks?view=trash")).body.tasks).toEqual([]);
    expect((await ada.post("/api/v1/tasks/empty-trash")).body).toEqual({ purged: 0, kept: 0, deletedIds: [] });
  });

  it("reorders owned lists and keeps inbox first", async () => {
    expect((await request(app).post("/api/v1/lists/reorder").send({ ids: [] })).status).toBe(401);
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const errands = await ada.post("/api/v1/lists").send({ name: "Errands" });
    const home = await grace.post("/api/v1/lists").send({ name: "Home" });
    expect((await ada.post("/api/v1/lists/reorder").send({ ids: [trip.body.id] })).status).toBe(400);
    const inboxId = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    expect((await ada.post("/api/v1/lists/reorder").send({ ids: [inboxId, errands.body.id] })).status).toBe(400);
    expect((await grace.post("/api/v1/lists/reorder").send({ ids: [trip.body.id] })).status).toBe(404);

    const moved = await ada.post("/api/v1/lists/reorder").send({ ids: [errands.body.id, trip.body.id] });
    expect(moved.status).toBe(204);
    expect((await ada.get("/api/v1/lists")).body.map((list: { name: string }) => list.name)).toEqual(["Inbox", "Errands", "Trip"]);
    expect((await grace.get("/api/v1/lists")).body.map((list: { name: string }) => list.name)).toEqual(["Inbox", "Home"]);
    expect(home.status).toBe(201);
  });

  it("archives a list without moving its tasks and renames a tag", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const task = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const inboxId = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    expect((await ada.patch(`/api/v1/lists/${inboxId}`).send({ archived: true })).status).toBe(400);
    expect((await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).archivedAt).toBeNull();
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await grace.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: true })).status).toBe(403);

    const archived = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    expect((await ada.get(`/api/v1/tasks/${task.body.id}`)).body.task.listId).toBe(trip.body.id);
    const restored = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: false });
    expect(restored.body.archivedAt).toBeNull();

    const travel = await ada.post("/api/v1/tags").send({ name: "Travel" });
    const bags = await ada.post("/api/v1/tags").send({ name: "Bags" });
    expect((await grace.patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Secret" })).status).toBe(404);
    expect((await ada.patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Bags" })).status).toBe(409);
    const renamed = await ada.patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Luggage", color: "plum" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Luggage", color: "plum" });
    expect(bags.status).toBe(201);
    expect((await request(app).patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Nope" })).status).toBe(401);
  });

  it("edits a list's name, color, and icon, and keeps the inbox name", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip", color: "sea", icon: "plane" });
    expect(trip.status).toBe(201);
    expect(trip.body).toMatchObject({ name: "Trip", color: "sea", icon: "plane" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await grace.patch(`/api/v1/lists/${trip.body.id}`).send({ name: "Stolen" })).status).toBe(403);
    const renamed = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ name: "Holiday", color: "gold", icon: "sun" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Holiday", color: "gold", icon: "sun" });
    const inboxId = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    expect((await ada.patch(`/api/v1/lists/${inboxId}`).send({ name: "Later" })).status).toBe(400);
    const tinted = await ada.patch(`/api/v1/lists/${inboxId}`).send({ color: "plum", icon: "moon" });
    expect(tinted.body).toMatchObject({ name: "Inbox", color: "plum", icon: "moon" });
    expect((await request(app).patch(`/api/v1/lists/${trip.body.id}`).send({ name: "Nope" })).status).toBe(401);
  });

  it("deletes a list and moves each task to its author's inbox", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const camera = await grace.post("/api/v1/tasks").send({ title: "Camera", listId: trip.body.id });
    expect((await grace.delete(`/api/v1/lists/${trip.body.id}`)).status).toBe(403);
    const adaInbox = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    const graceInbox = (await grace.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    expect((await ada.delete(`/api/v1/lists/${adaInbox}`)).status).toBe(400);
    expect((await ada.delete(`/api/v1/lists/${trip.body.id}`)).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.listId).toBe(adaInbox);
    expect((await grace.get(`/api/v1/tasks/${camera.body.id}`)).body.task.listId).toBe(graceInbox);
    expect((await ada.get("/api/v1/lists")).body.some((list: { name: string }) => list.name === "Trip")).toBe(false);
    expect((await request(app).delete(`/api/v1/lists/${trip.body.id}`)).status).toBe(401);
  });

  it("snoozes a due reminder and leaves a dismissed one closed", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    await ada.post("/api/v1/tasks").send({
      title: "Stand up",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      dueHasTime: true,
      reminderOffsetMinutes: 0,
    });
    const pending = await ada.get("/api/v1/reminders/pending");
    expect(pending.body).toHaveLength(1);
    const id = pending.body[0].id as string;
    expect((await grace.post(`/api/v1/reminders/${id}/snooze`).send({ minutes: 15 })).status).toBe(404);
    const snoozed = await ada.post(`/api/v1/reminders/${id}/snooze`).send({ minutes: 15 });
    expect(snoozed.status).toBe(200);
    expect(new Date(snoozed.body.fireAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await ada.get("/api/v1/reminders/pending")).body).toEqual([]);
    expect((await ada.post(`/api/v1/reminders/${id}/ack`)).status).toBe(204);
    expect((await ada.post(`/api/v1/reminders/${id}/snooze`).send({ minutes: 15 })).status).toBe(400);
    expect((await request(app).post(`/api/v1/reminders/${id}/snooze`).send({ minutes: 15 })).status).toBe(401);
  });

  it("postpones an open task by one day and counts its subtasks", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const parent = await ada.post("/api/v1/tasks").send({ title: "Pack" });
    const openChild = await ada.post("/api/v1/tasks").send({ title: "Socks", parentId: parent.body.id });
    const doneChild = await ada.post("/api/v1/tasks").send({ title: "Charger", parentId: parent.body.id });
    const goneChild = await ada.post("/api/v1/tasks").send({ title: "Map", parentId: parent.body.id });
    expect((await ada.post(`/api/v1/tasks/${doneChild.body.id}/complete`)).status).toBe(200);
    expect((await ada.delete(`/api/v1/tasks/${goneChild.body.id}`)).status).toBe(200);
    const listed = await ada.get("/api/v1/tasks?view=all");
    const row = listed.body.tasks.find((task: { title: string }) => task.title === "Pack");
    expect(row).toMatchObject({ subtaskCount: 2, openSubtaskCount: 1 });
    expect(openChild.status).toBe(201);

    const undated = await ada.post(`/api/v1/tasks/${parent.body.id}/postpone`);
    expect(undated.status).toBe(200);
    expect(undated.body.dueHasTime).toBe(false);
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const due = new Date(undated.body.dueAt);
    expect(due.getUTCFullYear()).toBe(tomorrow.getUTCFullYear());
    expect(due.getUTCMonth()).toBe(tomorrow.getUTCMonth());
    expect(due.getUTCDate()).toBe(tomorrow.getUTCDate());
    expect(due.getUTCHours()).toBe(0);

    const call = await ada.post("/api/v1/tasks").send({
      title: "Call",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const moved = await ada.post(`/api/v1/tasks/${call.body.id}/postpone`);
    expect(moved.body).toMatchObject({
      dueAt: "2026-10-16T15:00:00.000Z",
      dueHasTime: true,
      occurrenceOriginalDueAt: "2026-10-15T15:00:00.000Z",
    });
    expect(moved.body.recurrence.frequency).toBe("daily");
    expect((await ada.post(`/api/v1/tasks/${doneChild.body.id}/postpone`)).status).toBe(400);
    expect((await grace.post(`/api/v1/tasks/${call.body.id}/postpone`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/tasks/${call.body.id}/postpone`)).status).toBe(401);
  });

  it("copies a list as private open tasks and searches by the caller's tag name", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip", color: "sea", icon: "plane" });
    const travel = await ada.post("/api/v1/tags").send({ name: "Travel" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, tagIds: [travel.body.id] });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    const gone = await ada.post("/api/v1/tasks").send({ title: "Map", listId: trip.body.id });
    const old = await ada.post("/api/v1/tasks").send({ title: "Old ticket", listId: trip.body.id });
    expect((await ada.delete(`/api/v1/tasks/${gone.body.id}`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${old.body.id}/archive`)).status).toBe(200);
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const secret = await grace.post("/api/v1/tags").send({ name: "Secret" });
    const quiet = await grace.post("/api/v1/tasks").send({ title: "Quiet", tagIds: [secret.body.id] });

    const copied = await grace.post(`/api/v1/lists/${trip.body.id}/duplicate`);
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({ name: "Trip copy", color: "sea", icon: "plane", isInbox: false, role: "owner", copiedTasks: 2 });
    expect((await grace.get(`/api/v1/lists/${copied.body.id}/members`)).body).toEqual([
      expect.objectContaining({ email: "grace@example.com", role: "owner" }),
    ]);
    const titles = (await grace.get(`/api/v1/tasks?view=list&listId=${copied.body.id}`)).body.tasks.map((task: { title: string }) => task.title);
    expect(titles).toEqual(["Pack"]);
    const packCopy = (await grace.get(`/api/v1/tasks?view=list&listId=${copied.body.id}`)).body.tasks[0];
    expect(packCopy.tagIds).toEqual([]);
    expect(packCopy.id).not.toBe(pack.body.id);
    const detail = await grace.get(`/api/v1/tasks/${packCopy.id}`);
    expect(detail.body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Socks"]);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.listId).toBe(trip.body.id);
    expect(socks.status).toBe(201);
    expect(quiet.status).toBe(201);

    const inboxId = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    const inboxCopy = await ada.post(`/api/v1/lists/${inboxId}/duplicate`);
    expect(inboxCopy.body).toMatchObject({ name: "Inbox copy", isInbox: false });
    expect((await ada.get("/api/v1/tasks?view=search&q=Travel")).body.tasks.map((task: { title: string }) => task.title)).toContain("Pack");
    expect((await ada.get("/api/v1/tasks?view=search&q=Secret")).body.tasks).toEqual([]);
    expect((await grace.get("/api/v1/tasks?view=search&q=Secret")).body.tasks.map((task: { title: string }) => task.title)).toContain("Quiet");
    expect((await request(app).post(`/api/v1/lists/${trip.body.id}/duplicate`)).status).toBe(401);
    expect((await ada.post("/api/v1/lists/000000000000000000000001/duplicate")).status).toBe(404);
  });

  it("moves the caller's completed tasks to trash and leaves someone else's", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", parentId: pack.body.id, listId: trip.body.id });
    const open = await ada.post("/api/v1/tasks").send({ title: "Buy milk" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const camera = await grace.post("/api/v1/tasks").send({ title: "Camera", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/complete`)).status).toBe(200);
    expect((await grace.post(`/api/v1/tasks/${camera.body.id}/complete`)).status).toBe(200);

    const cleared = await ada.post("/api/v1/tasks/clear-completed");
    expect(cleared.body).toEqual({ deleted: 2, kept: 1, deletedIds: [pack.body.id] });
    expect((await ada.get("/api/v1/tasks?view=all")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Buy milk"]);
    const trash = (await ada.get("/api/v1/tasks?view=trash")).body.tasks.map((task: { title: string }) => task.title);
    expect(trash).toEqual(expect.arrayContaining(["Pack", "Socks"]));
    expect((await grace.get(`/api/v1/tasks/${camera.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.post("/api/v1/tasks/clear-completed")).body).toEqual({ deleted: 0, kept: 1, deletedIds: [] });
    const brought = await ada.post("/api/v1/tasks/restore").send({ ids: cleared.body.deletedIds });
    expect(brought.status).toBe(200);
    expect(brought.body.restored).toBe(1);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect(open.status).toBe(201);
    const nia = await register("nia@example.com", "Nia");
    expect((await nia.post("/api/v1/tasks/clear-completed")).body).toEqual({ deleted: 0, kept: 0, deletedIds: [] });
    expect((await request(app).post("/api/v1/tasks/clear-completed")).status).toBe(401);
  });

  it("moves selected tasks to another list and takes their subtasks along", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, estimatedMinutes: 30 });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const graceInbox = (await grace.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    const adaInbox = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    const blocked = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "move", listId: graceInbox });
    expect(blocked.status).toBe(200);
    expect(blocked.body.tasks[0]).toMatchObject({ id: pack.body.id, listId: trip.body.id, revision: pack.body.revision });
    expect((await grace.patch(`/api/v1/tasks/${pack.body.id}`).send({ listId: graceInbox, revision: pack.body.revision })).status).toBe(403);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.listId).toBe(trip.body.id);
    const camera = await grace.post("/api/v1/tasks").send({ title: "Camera", listId: trip.body.id });
    const mixed = await grace.post("/api/v1/tasks/batch").send({
      ids: [pack.body.id, camera.body.id],
      action: "move",
      listId: graceInbox,
    });
    expect(mixed.status).toBe(200);
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === pack.body.id)).toMatchObject({
      id: pack.body.id,
      listId: trip.body.id,
      revision: pack.body.revision,
    });
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === camera.body.id)).toMatchObject({
      listId: graceInbox,
      revision: camera.body.revision + 1,
    });
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "move" })).status).toBe(400);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "move", listId: "000000000000000000000099" })).status).toBe(404);

    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "move", listId: adaInbox });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks[0]).toMatchObject({ listId: adaInbox, estimatedMinutes: 30 });
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task).toMatchObject({ listId: adaInbox, parentId: pack.body.id });

    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: adaInbox, parentId: pack.body.id });
    const alone = await ada.post("/api/v1/tasks/batch").send({ ids: [hat.body.id], action: "move", listId: trip.body.id });
    expect(alone.status).toBe(200);
    expect(alone.body.tasks[0]).toMatchObject({ listId: trip.body.id, parentId: null });
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.listId).toBe(adaInbox);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "move", listId: adaInbox })).status).toBe(401);
  });

  it("sorts a list by due date, priority, and title", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const soon = await ada.post("/api/v1/tasks").send({
      title: "Soon",
      listId: trip.body.id,
      dueAt: "2026-10-01T12:00:00.000Z",
      dueHasTime: true,
      priority: "low",
    });
    const later = await ada.post("/api/v1/tasks").send({
      title: "Later",
      listId: trip.body.id,
      dueAt: "2026-10-20T12:00:00.000Z",
      dueHasTime: true,
      priority: "none",
    });
    const zebra = await ada.post("/api/v1/tasks").send({ title: "Zebra", listId: trip.body.id, priority: "high" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: soon.body.id });
    const errand = await ada.post("/api/v1/lists").send({ name: "Errands" });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: errand.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const before = (await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.sortOrder;
    expect((await grace.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "due" })).status).toBe(403);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.sortOrder).toBe(before);

    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "due" })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Soon",
      "Later",
      "Zebra",
    ]);
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "priority" })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Zebra",
      "Soon",
      "Later",
    ]);
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "title" })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Later",
      "Soon",
      "Zebra",
    ]);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task).toMatchObject({ sortOrder: before, parentId: soon.body.id });
    expect((await ada.get(`/api/v1/tasks/${milk.body.id}`)).body.task.sortOrder).toBe(milk.body.sortOrder);
    expect(later.status).toBe(201);
    expect(zebra.status).toBe(201);
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: "000000000000000000000099", by: "title" })).status).toBe(404);
    expect((await request(app).post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "title" })).status).toBe(401);
  });

  it("lists tasks with no date and refuses that filter on a date view", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const open = await ada.post("/api/v1/tasks").send({ title: "Someday", description: "When there is time" });
    const dated = await ada.post("/api/v1/tasks").send({ title: "Tomorrow", dueAt: "2026-10-20T12:00:00.000Z", dueHasTime: true });
    const quiet = await grace.post("/api/v1/tasks").send({ title: "Quiet" });
    const listed = await ada.get("/api/v1/tasks?view=all&due=none");
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Someday"]);
    expect((await ada.get("/api/v1/tasks?view=today&due=none")).status).toBe(400);
    expect((await ada.get("/api/v1/tasks?view=all")).body.tasks.map((task: { title: string }) => task.title)).toEqual(
      expect.arrayContaining(["Someday", "Tomorrow"]),
    );
    expect((await grace.get("/api/v1/tasks?view=all&due=none")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Quiet"]);
    expect(open.status).toBe(201);
    expect(dated.status).toBe(201);
    expect(quiet.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=all&due=none")).status).toBe(401);
  });

  it("hides a future start date from today and lists those tasks on request", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const now = Date.now();
    const due = new Date(now - 60_000).toISOString();
    const later = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    const soon = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();
    const waiting = await ada.post("/api/v1/tasks").send({ title: "Later", dueAt: due, startAt: later });
    const ready = await ada.post("/api/v1/tasks").send({ title: "Now", dueAt: due });
    const planned = await ada.post("/api/v1/tasks").send({ title: "Trip", dueAt: soon, startAt: soon });
    const quiet = await grace.post("/api/v1/tasks").send({ title: "Quiet", dueAt: due, startAt: later });
    const today = await ada.get("/api/v1/tasks?view=today");
    expect(today.status).toBe(200);
    expect(today.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Now"]);
    const held = await ada.get("/api/v1/tasks?view=today&started=waiting");
    expect(held.status).toBe(200);
    expect(held.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Later"]);
    const upcoming = await ada.get("/api/v1/tasks?view=upcoming");
    expect(upcoming.body.tasks.map((task: { title: string }) => task.title)).toEqual([]);
    expect((await ada.get("/api/v1/tasks?view=upcoming&started=waiting")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Trip"]);
    expect((await ada.get("/api/v1/tasks?view=all")).body.tasks.map((task: { title: string }) => task.title)).toEqual(
      expect.arrayContaining(["Later", "Now", "Trip"]),
    );
    expect((await ada.get("/api/v1/tasks?view=all&started=waiting")).status).toBe(400);
    expect((await grace.get("/api/v1/tasks?view=today&started=waiting")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Quiet"]);
    expect(waiting.status).toBe(201);
    expect(ready.status).toBe(201);
    expect(planned.status).toBe(201);
    expect(quiet.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=today&started=waiting")).status).toBe(401);
  });

  it("sets the priority of selected tasks and keeps a repeat rule's priority", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "priority", priority: "low" });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].priority).toBe("low");
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      priority: "none",
      recurrence: { frequency: "daily", interval: 1 },
    });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done" });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "priority" })).status).toBe(400);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [done.body.id, milk.body.id], action: "priority", priority: "high" });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      priority: "none",
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      priority: "high",
      revision: milk.body.revision + 1,
    });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "priority", priority: "high" })).status).toBe(404);
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const set = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, water.body.id], action: "priority", priority: "high" });
    expect(set.status).toBe(200);
    expect(set.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      priority: "high",
      revision: milkAfter.body.task.revision,
    });
    expect(set.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      priority: "high",
      recurrence: { frequency: "daily" },
      revision: water.body.revision + 1,
    });
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.priority).toBe("none");
    expect(next.body.recurrence.frequency).toBe("daily");
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "priority", priority: "high" })).status).toBe(401);
  });

  it("sets or clears the due date of selected tasks and keeps the repeat rule", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({
      ids: [pack.body.id],
      action: "due",
      dueAt: "2026-10-20T00:00:00.000Z",
      dueHasTime: false,
    });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0]).toMatchObject({ dueAt: "2026-10-20T00:00:00.000Z", dueHasTime: false });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const original = "2026-10-15T15:00:00.000Z";
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: original,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 2 },
    });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done" });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "due" })).status).toBe(400);
    const clearMixed = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, water.body.id], action: "due", dueAt: null });
    expect(clearMixed.status).toBe(200);
    expect(clearMixed.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      dueAt: null,
      revision: milk.body.revision,
    });
    expect(clearMixed.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      dueAt: original,
      revision: water.body.revision,
    });
    expect((await ada.patch(`/api/v1/tasks/${water.body.id}`).send({ revision: water.body.revision, dueAt: null })).status).toBe(400);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({
      ids: [done.body.id, milk.body.id],
      action: "due",
      dueAt: "2026-10-21T00:00:00.000Z",
      dueHasTime: false,
    });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      dueAt: "2026-10-21T00:00:00.000Z",
      dueHasTime: false,
      revision: milk.body.revision + 1,
    });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "due", dueAt: null })).status).toBe(404);
    const milkDated = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const dated = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, water.body.id],
      action: "due",
      dueAt: "2026-10-21T00:00:00.000Z",
      dueHasTime: false,
    });
    expect(dated.status).toBe(200);
    expect(dated.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      dueAt: "2026-10-21T00:00:00.000Z",
      dueHasTime: false,
      revision: milkDated.body.task.revision,
    });
    expect(dated.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      dueAt: "2026-10-21T00:00:00.000Z",
      dueHasTime: false,
      occurrenceOriginalDueAt: original,
      recurrence: { frequency: "daily", interval: 2 },
    });
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.dueAt).toBe("2026-10-17T15:00:00.000Z");
    expect(next.body.dueHasTime).toBe(true);
    expect(next.body.occurrenceOriginalDueAt).toBeNull();
    expect(next.body.recurrence.interval).toBe(2);
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "due", dueAt: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].dueAt).toBeNull();
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "due", dueAt: null })).status).toBe(401);
  });

  it("adds and removes the caller's tag on selected tasks", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const travel = await ada.post("/api/v1/tags").send({ name: "Travel" });
    const secret = await grace.post("/api/v1/tags").send({ name: "Secret" });
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "tag", tagId: secret.body.id, tagMode: "add" });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].tagIds).toEqual([secret.body.id]);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "weekly", interval: 1, byWeekday: [1, 3, 5] },
    });
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "tag" })).status).toBe(400);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "tag", tagId: secret.body.id, tagMode: "add" })).status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.tagIds).toEqual([secret.body.id]);
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "tag", tagId: secret.body.id, tagMode: "add" })).status).toBe(404);
    const tagged = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, water.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" });
    expect(tagged.status).toBe(200);
    expect(tagged.body.tasks[0].tagIds).toEqual([travel.body.id]);
    expect(tagged.body.tasks[1].tagIds).toEqual([travel.body.id]);
    expect(tagged.body.tasks[1].recurrence).toMatchObject({ frequency: "weekly", interval: 1, byWeekday: [1, 3, 5] });
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" });
    expect(again.status).toBe(200);
    expect(again.body.tasks[0].tagIds).toEqual([travel.body.id]);
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.tagIds).toEqual([travel.body.id]);
    expect(next.body.recurrence.byWeekday).toEqual([1, 3, 5]);
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "tag", tagId: travel.body.id, tagMode: "remove" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].tagIds).toEqual([]);
    expect(travel.status).toBe(201);
    expect(secret.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" })).status).toBe(401);
  });

  it("pins an open task to the top and leaves date views in due order", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id });
    const zebra = await ada.post("/api/v1/tasks").send({ title: "Zebra", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post(`/api/v1/tasks/${zebra.body.id}/pin`).send({ pinned: true });
    expect(shared.status).toBe(200);
    expect(shared.body.pinned).toBe(true);
    const listed = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`);
    expect(listed.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Zebra", "Apple"]);
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "title" })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Zebra",
      "Apple",
    ]);
    expect((await ada.post(`/api/v1/tasks/${zebra.body.id}/pin`).send({ pinned: false })).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Apple",
      "Zebra",
    ]);
    const earlier = new Date(Date.now() - 120_000).toISOString();
    const later = new Date(Date.now() - 60_000).toISOString();
    const first = await ada.post("/api/v1/tasks").send({ title: "First", dueAt: earlier, dueHasTime: true });
    const second = await ada.post("/api/v1/tasks").send({ title: "Second", dueAt: later, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${second.body.id}/pin`).send({ pinned: true })).status).toBe(200);
    expect((await ada.get("/api/v1/tasks?view=today")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["First", "Second"]);
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect((await ada.post(`/api/v1/tasks/${water.body.id}/pin`).send({ pinned: true })).status).toBe(200);
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.pinned).toBe(true);
    const done = await ada.post("/api/v1/tasks").send({ title: "Done" });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/pin`).send({ pinned: true })).status).toBe(400);
    expect((await grace.post(`/api/v1/tasks/${apple.body.id}/pin`).send({ pinned: true })).body.pinned).toBe(true);
    expect((await grace.post(`/api/v1/tasks/${first.body.id}/pin`).send({ pinned: true })).status).toBe(404);
    expect(apple.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${zebra.body.id}/pin`).send({ pinned: true })).status).toBe(401);
  });

  it("assigns an open task to someone on its list and can list only pinned tasks", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const adaId = (await ada.get("/api/v1/me")).body.id as string;
    const graceId = (await grace.get("/api/v1/me")).body.id as string;
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const assigned = await grace.post(`/api/v1/tasks/${pack.body.id}/assign`).send({ userId: graceId });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ assigneeId: graceId, assigneeName: "Grace Hopper" });
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.find((task: { title: string }) => task.title === "Pack")).toMatchObject({
      assigneeName: "Grace Hopper",
    });
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/assign`).send({ userId: "000000000000000000000099" })).status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.assigneeId).toBe(graceId);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    expect((await grace.post(`/api/v1/tasks/${milk.body.id}/assign`).send({ userId: graceId })).status).toBe(404);
    expect((await ada.post(`/api/v1/tasks/${milk.body.id}/assign`).send({ userId: graceId })).status).toBe(400);
    const owner = await ada.post(`/api/v1/tasks/${pack.body.id}/assign`).send({ userId: adaId });
    expect(owner.status).toBe(200);
    expect(owner.body.assigneeName).toBe("Ada Lovelace");
    const inbox = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "move", listId: inbox });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks[0].assigneeId).toBeNull();
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect((await ada.post(`/api/v1/tasks/${water.body.id}/assign`).send({ userId: graceId })).status).toBe(200);
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.assigneeId).toBe(graceId);
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/assign`).send({ userId: graceId })).status).toBe(400);
    expect((await ada.post(`/api/v1/tasks/${apple.body.id}/pin`).send({ pinned: true })).status).toBe(200);
    const pinned = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}&pinned=true`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Apple"]);
    expect((await ada.get("/api/v1/tasks?view=calendar&pinned=true&from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z")).status).toBe(400);
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/assign`).send({ userId: null })).body.assigneeId).toBeNull();
    expect(pack.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${apple.body.id}/assign`).send({ userId: null })).status).toBe(401);
  });

  it("lists tasks assigned to the caller and clears them when that person leaves", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const adaId = (await ada.get("/api/v1/me")).body.id as string;
    const graceId = (await grace.get("/api/v1/me")).body.id as string;
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/assign`).send({ userId: graceId })).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/assign`).send({ userId: graceId })).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${milk.body.id}/assign`).send({ userId: adaId })).status).toBe(200);
    const graceTasks = await grace.get("/api/v1/tasks?view=all&assignee=me");
    expect(graceTasks.status).toBe(200);
    expect(graceTasks.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Pack"]);
    expect((await ada.get("/api/v1/tasks?view=all&assignee=me")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Milk"]);
    expect((await ada.get("/api/v1/tasks?view=all&assignee=grace")).status).toBe(400);
    expect((await ada.get("/api/v1/tasks?view=calendar&assignee=me&from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z")).status).toBe(400);
    expect((await ada.delete(`/api/v1/lists/${trip.body.id}/members/${graceId}`)).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.assigneeId).toBeNull();
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.assigneeId).toBeNull();
    expect((await grace.get("/api/v1/tasks?view=all&assignee=me")).body.tasks).toEqual([]);
    expect((await ada.get(`/api/v1/tasks/${milk.body.id}`)).body.task.assigneeId).toBe(adaId);
    expect(milk.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=all&assignee=me")).status).toBe(401);
  });

  it("reopens finished tasks and leaves the selection unchanged when one is still open", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread" });
    const open = await ada.post("/api/v1/tasks").send({ title: "Open" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${milk.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${bread.body.id}/complete`)).status).toBe(200);
    const mixedOpen = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, open.body.id], action: "reopen" });
    expect(mixedOpen.status).toBe(200);
    expect(mixedOpen.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      status: "open",
      completedAt: null,
      revision: milk.body.revision + 2,
    });
    expect(mixedOpen.body.tasks.find((task: { id: string }) => task.id === open.body.id)).toMatchObject({
      id: open.body.id,
      status: "open",
      revision: open.body.revision,
    });
    expect((await ada.post(`/api/v1/tasks/${open.body.id}/uncomplete`)).status).toBe(400);
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "reopen" })).status).toBe(404);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "reopen" });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].status).toBe("open");
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const reopened = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, bread.body.id], action: "reopen" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      status: "open",
      completedAt: null,
      revision: milkAfter.body.task.revision,
    });
    expect(reopened.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      status: "open",
      completedAt: null,
      revision: bread.body.revision + 2,
    });
    expect((await ada.get("/api/v1/tasks?view=completed")).body.tasks.map((task: { title: string }) => task.title)).toEqual([]);
    expect((await ada.get("/api/v1/tasks?view=all")).body.tasks.map((task: { title: string }) => task.title)).toEqual(
      expect.arrayContaining(["Milk", "Bread", "Open"]),
    );
    expect(open.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "reopen" })).status).toBe(401);
  });

  it("sets a reminder on selected tasks and keeps the repeat rule's reminder", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-20T15:00:00.000Z";
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "remind", reminderOffsetMinutes: 15 });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].reminderOffsetMinutes).toBe(15);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", dueAt: due, dueHasTime: true });
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "remind" })).status).toBe(400);
    const noDue = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, bread.body.id], action: "remind", reminderOffsetMinutes: 60 });
    expect(noDue.status).toBe(200);
    expect(noDue.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      id: milk.body.id,
      reminderOffsetMinutes: null,
      revision: milk.body.revision,
    });
    expect(noDue.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      reminderOffsetMinutes: 60,
      revision: bread.body.revision + 1,
    });
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [done.body.id, bread.body.id], action: "remind", reminderOffsetMinutes: 60 });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      reminderOffsetMinutes: 60,
      revision: bread.body.revision + 1,
    });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "remind", reminderOffsetMinutes: null })).status).toBe(404);
    const breadAfter = await ada.get(`/api/v1/tasks/${bread.body.id}`);
    const set = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id, water.body.id], action: "remind", reminderOffsetMinutes: 60 });
    expect(set.status).toBe(200);
    expect(set.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      reminderOffsetMinutes: 60,
      revision: breadAfter.body.task.revision,
    });
    expect(set.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      reminderOffsetMinutes: 60,
      recurrence: { frequency: "daily" },
      revision: water.body.revision + 1,
    });
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.reminderOffsetMinutes).toBeNull();
    expect(next.body.recurrence.frequency).toBe("daily");
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "remind", reminderOffsetMinutes: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].reminderOffsetMinutes).toBeNull();
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "remind", reminderOffsetMinutes: 15 })).status).toBe(401);
  });

  it("postpones selected tasks and can list only overdue tasks", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T15:00:00.000Z";
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "postpone" });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0]).toMatchObject({ dueAt: "2026-10-16T15:00:00.000Z", dueHasTime: true });
    const late = await ada.post("/api/v1/tasks").send({ title: "Late", dueAt: "2026-10-14T15:00:00.000Z", dueHasTime: true });
    const today = await ada.post("/api/v1/tasks").send({ title: "Today", dueAt: due, dueHasTime: true });
    const later = await ada.post("/api/v1/tasks").send({ title: "Later", dueAt: "2026-10-20T15:00:00.000Z", dueHasTime: true });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [done.body.id, today.body.id], action: "postpone" });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      dueAt: due,
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === today.body.id)).toMatchObject({
      id: today.body.id,
      dueAt: "2026-10-16T15:00:00.000Z",
      dueHasTime: true,
    });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/postpone`)).status).toBe(400);
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "postpone" })).status).toBe(404);
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, water.body.id], action: "postpone" });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks[0].dueHasTime).toBe(false);
    expect(moved.body.tasks[0].dueAt.endsWith("T00:00:00.000Z")).toBe(true);
    expect(moved.body.tasks[1]).toMatchObject({
      dueAt: "2026-10-16T15:00:00.000Z",
      dueHasTime: true,
      occurrenceOriginalDueAt: due,
    });
    expect(moved.body.tasks[1].recurrence.frequency).toBe("daily");
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.dueAt).toBe("2026-10-16T15:00:00.000Z");
    expect(next.body.occurrenceOriginalDueAt).toBeNull();
    expect(next.body.recurrence.frequency).toBe("daily");
    const overdue = await ada.get("/api/v1/tasks?view=all&due=overdue");
    expect(overdue.status).toBe(200);
    expect(overdue.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Late"]);
    const todayOverdue = await ada.get("/api/v1/tasks?view=today&due=overdue");
    expect(todayOverdue.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Late"]);
    expect((await ada.get("/api/v1/tasks?view=upcoming&due=overdue")).status).toBe(400);
    expect((await ada.get("/api/v1/tasks?view=completed&due=overdue")).status).toBe(400);
    expect((await ada.get("/api/v1/tasks?view=calendar&due=overdue&from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z")).status).toBe(400);
    expect(late.status).toBe(201);
    expect(later.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [today.body.id], action: "postpone" })).status).toBe(401);
  });

  it("sets the start date of selected tasks and keeps it on the repeat rule", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const start = "2026-11-01T00:00:00.000Z";
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, dueAt: "2026-11-02T15:00:00.000Z", dueHasTime: true });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "start", startAt: start });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].startAt).toBe(start);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", dueAt: "2026-11-02T15:00:00.000Z", dueHasTime: true });
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done" });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "start" })).status).toBe(400);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [done.body.id, bread.body.id], action: "start", startAt: start });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      startAt: null,
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      startAt: start,
      revision: bread.body.revision + 1,
    });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "start", startAt: null })).status).toBe(404);
    const breadAfter = await ada.get(`/api/v1/tasks/${bread.body.id}`);
    const set = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id, water.body.id], action: "start", startAt: start });
    expect(set.status).toBe(200);
    expect(set.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      startAt: start,
      revision: breadAfter.body.task.revision,
    });
    expect(set.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      startAt: start,
      recurrence: { frequency: "daily" },
      revision: water.body.revision + 1,
    });
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.startAt).toBe(start);
    expect(next.body.recurrence.frequency).toBe("daily");
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "start", startAt: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].startAt).toBeNull();
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "start", startAt: start })).status).toBe(401);
  });

  it("sets the estimate of selected tasks and keeps it on the repeat rule", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "estimate", estimatedMinutes: 30 });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].estimatedMinutes).toBe(30);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread" });
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done" });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "estimate" })).status).toBe(400);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [done.body.id, bread.body.id], action: "estimate", estimatedMinutes: 45 });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      estimatedMinutes: null,
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      estimatedMinutes: 45,
      revision: bread.body.revision + 1,
    });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "estimate", estimatedMinutes: null })).status).toBe(404);
    const breadAfter = await ada.get(`/api/v1/tasks/${bread.body.id}`);
    const set = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id, water.body.id], action: "estimate", estimatedMinutes: 45 });
    expect(set.status).toBe(200);
    expect(set.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      estimatedMinutes: 45,
      revision: breadAfter.body.task.revision,
    });
    expect(set.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      estimatedMinutes: 45,
      recurrence: { frequency: "daily" },
      revision: water.body.revision + 1,
    });
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.estimatedMinutes).toBe(45);
    expect(next.body.recurrence.frequency).toBe("daily");
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "estimate", estimatedMinutes: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].estimatedMinutes).toBeNull();
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "estimate", estimatedMinutes: 15 })).status).toBe(401);
  });

  it("pins selected open tasks and leaves the selection unchanged when one is finished", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const shared = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "pin", pinned: true });
    expect(shared.status).toBe(200);
    expect(shared.body.tasks[0].pinned).toBe(true);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread" });
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done" });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "pin" })).status).toBe(400);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [done.body.id, bread.body.id], action: "pin", pinned: true });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      pinned: false,
      revision: done.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      pinned: true,
      revision: bread.body.revision + 1,
    });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/pin`).send({ pinned: true })).status).toBe(400);
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "pin", pinned: false })).status).toBe(404);
    const set = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id, water.body.id], action: "pin", pinned: true });
    expect(set.status).toBe(200);
    expect(set.body.tasks.map((task: { pinned: boolean }) => task.pinned)).toEqual([true, true]);
    expect(set.body.tasks[1].recurrence.frequency).toBe("daily");
    const next = await ada.post(`/api/v1/tasks/${water.body.id}/complete`);
    expect(next.status).toBe(200);
    expect(next.body.pinned).toBe(true);
    expect(next.body.recurrence.frequency).toBe("daily");
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "pin", pinned: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].pinned).toBe(false);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "pin", pinned: true })).status).toBe(401);
  });

  it("duplicates selected tasks and completes open tasks when one is archived", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, milk.body.id], action: "duplicate" })).status).toBe(404);
    const listedBefore = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`);
    expect(listedBefore.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Pack"]);
    const copied = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "duplicate" });
    expect(copied.status).toBe(200);
    expect(copied.body.tasks[0].title).toBe("Pack");
    expect(copied.body.tasks[0].status).toBe("open");
    expect(copied.body.tasks[0].id).not.toBe(pack.body.id);
    const detail = await grace.get(`/api/v1/tasks/${copied.body.tasks[0].id}`);
    expect(detail.body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Socks"]);
    const open = await ada.post("/api/v1/tasks").send({ title: "Open" });
    const stored = await ada.post("/api/v1/tasks").send({ title: "Stored" });
    const archived = await ada.post(`/api/v1/tasks/${stored.body.id}/archive`);
    expect(archived.status).toBe(200);
    const mixedArchived = await ada.post("/api/v1/tasks/batch").send({ ids: [open.body.id, stored.body.id], action: "complete" });
    expect(mixedArchived.status).toBe(200);
    expect(mixedArchived.body.tasks.find((task: { id: string }) => task.id === open.body.id)).toMatchObject({
      status: "completed",
      revision: open.body.revision + 1,
    });
    expect(mixedArchived.body.tasks.find((task: { id: string }) => task.id === stored.body.id)).toMatchObject({
      id: stored.body.id,
      status: "archived",
      revision: archived.body.revision,
    });
    expect((await ada.post(`/api/v1/tasks/${stored.body.id}/complete`)).status).toBe(400);
    const stay = await ada.post("/api/v1/tasks").send({ title: "Stay" });
    expect((await ada.delete(`/api/v1/tasks/${milk.body.id}`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, stay.body.id], action: "delete" })).status).toBe(404);
    expect((await ada.get(`/api/v1/tasks/${stay.body.id}`)).body.task.deletedAt).toBeNull();
    expect(socks.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "duplicate" })).status).toBe(401);
  });

  it("archives selected tasks and copies a selected subtask only once", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const both = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, socks.body.id], action: "duplicate" });
    expect(both.status).toBe(200);
    expect(both.body.tasks).toHaveLength(1);
    expect(both.body.tasks[0].id).not.toBe(pack.body.id);
    expect((await ada.get(`/api/v1/tasks/${both.body.tasks[0].id}`)).body.subtasks).toHaveLength(1);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.subtasks).toHaveLength(1);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, milk.body.id], action: "archive" })).status).toBe(404);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.status).toBe("open");
    const archived = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "archive" });
    expect(archived.status).toBe(200);
    expect(archived.body.tasks[0].status).toBe("archived");
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "archive" });
    expect(again.status).toBe(200);
    expect(again.body.tasks[0].revision).toBe(archived.body.tasks[0].revision);
    expect(socks.status).toBe(201);
    expect(milk.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "archive" })).status).toBe(401);
  });

  it("archives subtasks with the task and can restore the selection", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-14T15:00:00.000Z";
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const openOnly = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, milk.body.id], action: "unarchive" });
    expect(openOnly.status).toBe(200);
    expect(openOnly.body.tasks.map((task: { id: string; status: string; revision: number }) => [task.id, task.status, task.revision])).toEqual([
      [pack.body.id, "open", pack.body.revision],
      [milk.body.id, "open", milk.body.revision],
    ]);
    expect((await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, milk.body.id], action: "unarchive" })).status).toBe(404);
    const archived = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "archive" });
    expect(archived.status).toBe(200);
    expect(archived.body.tasks[0].status).toBe("archived");
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("archived");
    const today = await ada.get("/api/v1/tasks?view=today");
    expect(today.body.tasks.map((task: { title: string }) => task.title)).not.toContain("Socks");
    const open = await ada.post("/api/v1/tasks").send({ title: "Open" });
    const mixed = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, open.body.id], action: "unarchive" });
    expect(mixed.status).toBe(200);
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === pack.body.id)).toMatchObject({ status: "open", revision: archived.body.tasks[0].revision + 1 });
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === open.body.id)).toMatchObject({ status: "open", revision: open.body.revision });
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("open");
    expect(milk.status).toBe(201);
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "unarchive" })).status).toBe(401);
  });

  it("skips selected repeating tasks and deletes a selected subtask once", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T15:00:00.000Z";
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const removed = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, socks.body.id], action: "delete" });
    expect(removed.status).toBe(200);
    expect(removed.body.tasks).toHaveLength(1);
    const trash = await ada.get("/api/v1/tasks?view=trash");
    expect(trash.body.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["Pack", "Socks"]);
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const breadOnly = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "skip" });
    expect(breadOnly.status).toBe(200);
    expect(breadOnly.body.tasks[0]).toMatchObject({ id: bread.body.id, dueAt: due, revision: bread.body.revision });
    expect((await ada.post(`/api/v1/tasks/${bread.body.id}/skip`)).status).toBe(400);
    const mixed = await ada.post("/api/v1/tasks/batch").send({ ids: [water.body.id, bread.body.id], action: "skip" });
    expect(mixed.status).toBe(200);
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      dueAt: "2026-10-16T15:00:00.000Z",
      recurrence: { frequency: "daily" },
    });
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      dueAt: due,
      revision: bread.body.revision,
    });
    const skipped = await grace.post("/api/v1/tasks/batch").send({ ids: [water.body.id], action: "skip" });
    expect(skipped.status).toBe(200);
    expect(skipped.body.tasks[0].dueAt).toBe("2026-10-17T15:00:00.000Z");
    expect(skipped.body.tasks[0].recurrence.frequency).toBe("daily");
    expect(pack.status).toBe(201);
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [water.body.id], action: "skip" })).status).toBe(401);
  });

  it("drops one date from selected repeating tasks and restores subtasks with the parent", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T15:00:00.000Z";
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await ada.delete(`/api/v1/tasks/${pack.body.id}`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).status).toBe(404);
    const restored = await ada.post(`/api/v1/tasks/${pack.body.id}/restore`);
    expect(restored.status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.deletedAt).toBeNull();
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const breadOnly = await ada.post("/api/v1/tasks/batch").send({ ids: [bread.body.id], action: "omit" });
    expect(breadOnly.status).toBe(200);
    expect(breadOnly.body.tasks[0]).toMatchObject({ id: bread.body.id, dueAt: due, revision: bread.body.revision });
    expect((await ada.post(`/api/v1/tasks/${bread.body.id}/omit`)).status).toBe(400);
    const mixed = await ada.post("/api/v1/tasks/batch").send({ ids: [water.body.id, bread.body.id], action: "omit" });
    expect(mixed.status).toBe(200);
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      dueAt: "2026-10-16T15:00:00.000Z",
      recurrence: { frequency: "daily" },
      status: "open",
    });
    expect(mixed.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      dueAt: due,
      revision: bread.body.revision,
    });
    const omitted = await grace.post("/api/v1/tasks/batch").send({ ids: [water.body.id], action: "omit" });
    expect(omitted.status).toBe(200);
    expect(omitted.body.tasks[0].dueAt).toBe("2026-10-17T15:00:00.000Z");
    expect(omitted.body.tasks[0].recurrence.frequency).toBe("daily");
    expect(omitted.body.tasks[0].status).toBe("open");
    expect(pack.status).toBe(201);
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [water.body.id], action: "omit" })).status).toBe(401);
  });

  it("assigns selected open tasks and leaves archived subtasks off a copy", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const adaId = (await ada.get("/api/v1/me")).body.id as string;
    const graceId = (await grace.get("/api/v1/me")).body.id as string;
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: pack.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/archive`)).status).toBe(200);
    const copy = await ada.post(`/api/v1/tasks/${pack.body.id}/duplicate`);
    expect(copy.status).toBe(201);
    const copied = await ada.get(`/api/v1/tasks/${copy.body.id}`);
    expect(copied.body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Hat"]);
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({ ids: [water.body.id, done.body.id], action: "assign", assigneeId: graceId });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      assigneeId: graceId,
      assigneeName: "Grace Hopper",
      revision: water.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      assigneeId: null,
      revision: done.body.revision + 1,
    });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/assign`).send({ userId: graceId })).status).toBe(400);
    const assigned = await grace.post("/api/v1/tasks/batch").send({ ids: [water.body.id, bread.body.id], action: "assign", assigneeId: graceId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      assigneeId: graceId,
      assigneeName: "Grace Hopper",
      revision: water.body.revision + 1,
    });
    expect(assigned.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      assigneeId: graceId,
      assigneeName: "Grace Hopper",
      revision: bread.body.revision + 1,
    });
    expect(assigned.body.tasks.find((task: { id: string }) => task.id === water.body.id).recurrence.frequency).toBe("daily");
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const mixedList = await ada.post("/api/v1/tasks/batch").send({ ids: [water.body.id, milk.body.id], action: "assign", assigneeId: graceId });
    expect(mixedList.status).toBe(200);
    expect(mixedList.body.tasks.find((task: { id: string }) => task.id === water.body.id)).toMatchObject({
      assigneeId: graceId,
      revision: water.body.revision + 1,
    });
    expect(mixedList.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      id: milk.body.id,
      assigneeId: null,
      revision: milk.body.revision,
    });
    expect((await ada.post(`/api/v1/tasks/${milk.body.id}/assign`).send({ userId: graceId })).status).toBe(400);
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [water.body.id, bread.body.id], action: "assign", assigneeId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks.map((task: { assigneeId: string | null }) => task.assigneeId)).toEqual([null, null]);
    const owner = await ada.post("/api/v1/tasks/batch").send({ ids: [water.body.id], action: "assign", assigneeId: adaId });
    expect(owner.status).toBe(200);
    expect(owner.body.tasks[0].assigneeName).toBe("Ada Lovelace");
    expect(hat.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [water.body.id], action: "assign", assigneeId: null })).status).toBe(401);
  });

  it("sets the repeat rule of selected tasks and completes subtasks with the task", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T12:00:00.000Z";
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: water.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${water.body.id}/complete`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${hat.body.id}`)).body.task.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${water.body.id}`)).body.task.status).toBe("open");
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id, dueAt: due, dueHasTime: true });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread" });
    const completed = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, socks.body.id], action: "complete" });
    expect(completed.status).toBe(200);
    expect(completed.body.tasks).toHaveLength(1);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${bread.body.id}`)).body.task.status).toBe("open");
    expect((await ada.get("/api/v1/tasks?view=today")).body.tasks.map((task: { title: string }) => task.title)).not.toContain("Socks");
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", listId: trip.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    const mixedBread = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, bread.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect(mixedBread.status).toBe(200);
    expect(mixedBread.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { frequency: "daily", interval: 1 },
      revision: milk.body.revision + 1,
    });
    expect(mixedBread.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      recurrence: null,
      revision: bread.body.revision,
    });
    expect(
      (
        await ada.patch(`/api/v1/tasks/${bread.body.id}`).send({
          revision: bread.body.revision,
          recurrence: { frequency: "daily", interval: 1 },
        })
      ).status,
    ).toBe(400);
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, done.body.id],
      action: "repeat",
      recurrence: { frequency: "weekly", interval: 1 },
    });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { frequency: "weekly", interval: 1 },
      revision: milkAfter.body.task.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      recurrence: null,
      revision: done.body.revision + 1,
    });
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: null })).status).toBe(200);
    const repeated = await grace.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, apple.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1 },
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.tasks.map((task: { recurrence: { frequency: string } }) => task.recurrence.frequency)).toEqual(["daily", "daily"]);
    const cleared = await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, apple.body.id], action: "repeat", recurrence: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks.map((task: { recurrence: unknown }) => task.recurrence)).toEqual([null, null]);
    expect(hat.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: null })).status).toBe(401);
  });

  it("sets the weekdays of selected tasks and reopens subtasks with the task", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T12:00:00.000Z";
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/complete`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: water.body.id });
    expect((await ada.post(`/api/v1/tasks/${water.body.id}/complete`)).status).toBe(200);
    const undone = await ada.post(`/api/v1/tasks/${water.body.id}/uncomplete`);
    expect(undone.status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${hat.body.id}`)).body.task.status).toBe("open");
    const reopened = await grace.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, socks.body.id], action: "reopen" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.tasks).toHaveLength(1);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("open");
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id });
    const withBread = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, bread.body.id],
      action: "repeat",
      recurrence: { frequency: "weekly", interval: 1, byWeekday: [1, 3, 5] },
    });
    expect(withBread.status).toBe(200);
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { frequency: "weekly", interval: 1, byWeekday: [1, 3, 5] },
      revision: milk.body.revision + 1,
    });
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      recurrence: null,
      revision: bread.body.revision,
    });
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const repeated = await grace.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, apple.body.id],
      action: "repeat",
      recurrence: { frequency: "weekly", interval: 1, byWeekday: [1, 3, 5] },
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { byWeekday: [1, 3, 5] },
      revision: milkAfter.body.task.revision,
    });
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === apple.body.id)).toMatchObject({
      recurrence: { byWeekday: [1, 3, 5] },
      revision: apple.body.revision + 1,
    });
    expect(hat.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: null })).status).toBe(401);
  });

  it("sets how often selected tasks repeat and cancels subtask reminders when the task is deleted", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T12:00:00.000Z";
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id, dueAt: due, dueHasTime: true, reminderOffsetMinutes: 15 });
    const socks = await ada.post("/api/v1/tasks").send({
      title: "Socks",
      listId: trip.body.id,
      parentId: pack.body.id,
      dueAt: due,
      dueHasTime: true,
      reminderOffsetMinutes: 15,
    });
    expect((await Reminder.findOne({ taskId: socks.body.id }))?.status).toBe("scheduled");
    expect((await ada.delete(`/api/v1/tasks/${pack.body.id}`)).status).toBe(200);
    expect((await Reminder.findOne({ taskId: socks.body.id }))?.status).toBe("cancelled");
    expect((await Reminder.findOne({ taskId: pack.body.id }))?.status).toBe("cancelled");
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id });
    const withBread = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, bread.body.id],
      action: "repeat",
      recurrence: { frequency: "weekly", interval: 2, byWeekday: [1, 3, 5] },
    });
    expect(withBread.status).toBe(200);
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { frequency: "weekly", interval: 2, byWeekday: [1, 3, 5] },
      revision: milk.body.revision + 1,
    });
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      recurrence: null,
      revision: bread.body.revision,
    });
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: { frequency: "daily", interval: 0 } })).status).toBe(400);
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const repeated = await grace.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, apple.body.id],
      action: "repeat",
      recurrence: { frequency: "weekly", interval: 2, byWeekday: [1, 3, 5] },
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { interval: 2, byWeekday: [1, 3, 5] },
      revision: milkAfter.body.task.revision,
    });
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === apple.body.id)).toMatchObject({
      recurrence: { interval: 2, byWeekday: [1, 3, 5] },
      revision: apple.body.revision + 1,
    });
    expect(socks.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: { frequency: "daily", interval: 2 } })).status).toBe(401);
  });

  it("sets how many times selected tasks repeat and files a finished series in Completed", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T12:00:00.000Z";
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const pack = await ada.post("/api/v1/tasks").send({
      title: "Pack",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1, count: 1 },
    });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id, dueAt: due, dueHasTime: true });
    const finished = await ada.post(`/api/v1/tasks/${pack.body.id}/complete`);
    expect(finished.status).toBe(200);
    expect(finished.body.status).toBe("completed");
    expect(finished.body.recurrence).toBeNull();
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get("/api/v1/tasks?view=completed")).body.tasks.map((task: { title: string }) => task.title)).toContain("Pack");
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1, count: 2 },
    });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: water.body.id });
    expect((await ada.post(`/api/v1/tasks/${water.body.id}/complete`)).body.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${hat.body.id}`)).body.task.status).toBe("open");
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id });
    const withBread = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, bread.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1, count: 4 },
    });
    expect(withBread.status).toBe(200);
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { frequency: "daily", interval: 1, count: 4 },
      revision: milk.body.revision + 1,
    });
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      recurrence: null,
      revision: bread.body.revision,
    });
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: { frequency: "daily", interval: 1, count: 0 } })).status).toBe(400);
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const repeated = await grace.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, apple.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1, count: 4 },
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { count: 4 },
      revision: milkAfter.body.task.revision,
    });
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === apple.body.id)).toMatchObject({
      recurrence: { count: 4 },
      revision: apple.body.revision + 1,
    });
    expect(hat.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: { frequency: "daily", interval: 1, count: 4 } })).status).toBe(401);
  });

  it("sets the end date of selected repeating tasks and rejects an end before the due date", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T12:00:00.000Z";
    const until = "2026-10-20T23:59:00.000Z";
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id, dueAt: due, dueHasTime: true });
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id });
    const early = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1, until: "2026-10-14T23:59:00.000Z" },
    });
    expect(early.status).toBe(200);
    expect(early.body.tasks[0]).toMatchObject({ id: milk.body.id, recurrence: null, revision: milk.body.revision });
    expect((await ada.patch(`/api/v1/tasks/${milk.body.id}`).send({
      revision: milk.body.revision,
      recurrence: { frequency: "daily", interval: 1, until: "2026-10-14T23:59:00.000Z" },
    })).status).toBe(400);
    const withBread = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, bread.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1, until },
    });
    expect(withBread.status).toBe(200);
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { frequency: "daily", interval: 1, until },
      revision: milk.body.revision + 1,
    });
    expect(withBread.body.tasks.find((task: { id: string }) => task.id === bread.body.id)).toMatchObject({
      id: bread.body.id,
      recurrence: null,
      revision: bread.body.revision,
    });
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const repeated = await grace.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, apple.body.id],
      action: "repeat",
      recurrence: { frequency: "daily", interval: 1, until },
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      recurrence: { until },
      revision: milkAfter.body.task.revision,
    });
    expect(repeated.body.tasks.find((task: { id: string }) => task.id === apple.body.id)).toMatchObject({
      recurrence: { until },
      revision: apple.body.revision + 1,
    });
    const last = await ada.post("/api/v1/tasks").send({
      title: "Last",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1, until: "2026-10-15T23:59:00.000Z" },
    });
    const finished = await ada.post(`/api/v1/tasks/${last.body.id}/complete`);
    expect(finished.status).toBe(200);
    expect(finished.body.status).toBe("completed");
    expect(finished.body.recurrence).toBeNull();
    expect((await ada.get("/api/v1/tasks?view=completed")).body.tasks.map((task: { title: string }) => task.title)).toContain("Last");
    expect(bread.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "repeat", recurrence: { frequency: "daily", interval: 1, until } })).status).toBe(401);
  });

  it("sets the time of selected tasks and postpones subtasks with the task", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    const charger = await ada.post("/api/v1/tasks").send({ title: "Charger", listId: trip.body.id, parentId: pack.body.id });
    expect((await ada.post(`/api/v1/tasks/${charger.body.id}/complete`)).status).toBe(200);
    const postponed = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, socks.body.id], action: "postpone" });
    expect(postponed.status).toBe(200);
    expect(postponed.body.tasks).toHaveLength(1);
    const parentDue = (await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.dueAt;
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.dueAt).toBe(parentDue);
    expect((await ada.get(`/api/v1/tasks/${charger.body.id}`)).body.task.dueAt).toBeNull();
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: "2026-10-15T15:00:00.000Z",
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: water.body.id });
    expect((await ada.post(`/api/v1/tasks/${water.body.id}/postpone`)).body.dueAt).toBe("2026-10-16T15:00:00.000Z");
    expect((await ada.get(`/api/v1/tasks/${hat.body.id}`)).body.task.dueAt).toBeNull();
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id });
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    const when = "2026-10-20T15:30:00.000Z";
    const mixedDone = await ada.post("/api/v1/tasks/batch").send({
      ids: [milk.body.id, done.body.id],
      action: "due",
      dueAt: when,
      dueHasTime: true,
    });
    expect(mixedDone.status).toBe(200);
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      dueAt: when,
      dueHasTime: true,
      revision: milk.body.revision + 1,
    });
    expect(mixedDone.body.tasks.find((task: { id: string }) => task.id === done.body.id)).toMatchObject({
      id: done.body.id,
      status: "completed",
      dueAt: null,
      revision: done.body.revision + 1,
    });
    const milkAfter = await ada.get(`/api/v1/tasks/${milk.body.id}`);
    const dated = await grace.post("/api/v1/tasks/batch").send({ ids: [milk.body.id, apple.body.id], action: "due", dueAt: when, dueHasTime: true });
    expect(dated.status).toBe(200);
    expect(dated.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      dueAt: when,
      dueHasTime: true,
      revision: milkAfter.body.task.revision,
    });
    expect(dated.body.tasks.find((task: { id: string }) => task.id === apple.body.id)).toMatchObject({
      dueAt: when,
      dueHasTime: true,
      revision: apple.body.revision + 1,
    });
    expect(hat.status).toBe(201);
    expect(pack.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [milk.body.id], action: "due", dueAt: when, dueHasTime: true })).status).toBe(401);
  });

  it("sets the end date on one task and rejects a subtask on a finished task", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T12:00:00.000Z";
    const until = "2026-10-20T23:59:00.000Z";
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${milk.body.id}/complete`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks").send({ title: "Cap", listId: trip.body.id, parentId: milk.body.id })).status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${milk.body.id}`)).body.subtasks).toEqual([]);
    const bread = await ada.post("/api/v1/tasks").send({ title: "Bread", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${bread.body.id}/archive`)).status).toBe(200);
    expect((await ada.post("/api/v1/tasks").send({ title: "Crust", listId: trip.body.id, parentId: bread.body.id })).status).toBe(400);
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id });
    const slice = await ada.post("/api/v1/tasks").send({ title: "Slice", listId: trip.body.id, parentId: apple.body.id });
    expect(slice.status).toBe(201);
    const water = await ada.post("/api/v1/tasks").send({
      title: "Water",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const early = await ada.patch(`/api/v1/tasks/${water.body.id}`).send({
      recurrence: { frequency: "daily", interval: 1, until: "2026-10-14T23:59:00.000Z" },
      revision: water.body.revision,
    });
    expect(early.status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${water.body.id}`)).body.task.recurrence.until).toBeUndefined();
    const saved = await ada.patch(`/api/v1/tasks/${water.body.id}`).send({
      title: "Water the plants",
      recurrence: { frequency: "daily", interval: 1, until },
      revision: water.body.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.recurrence.until).toBe(until);
    const kept = await ada.patch(`/api/v1/tasks/${water.body.id}`).send({
      title: "Water the plants",
      recurrence: { frequency: "daily", interval: 1, until },
      revision: saved.body.revision,
    });
    expect(kept.status).toBe(200);
    expect(kept.body.recurrence.until).toBe(until);
    expect(milk.status).toBe(201);
    expect(apple.status).toBe(201);
    expect((await request(app).patch(`/api/v1/tasks/${water.body.id}`).send({ title: "Nope", revision: kept.body.revision })).status).toBe(401);
  });

  it("puts selected tasks under an open task and rejects a parent that already has subtasks", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const home = await ada.post("/api/v1/lists").send({ name: "Home" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: pack.body.id });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", listId: trip.body.id });
    const cup = await ada.post("/api/v1/tasks").send({ title: "Cup", listId: trip.body.id });
    const nestedPack = await ada.patch(`/api/v1/tasks/${pack.body.id}`).send({ parentId: tent.body.id, revision: pack.body.revision });
    expect(nestedPack.status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task.parentId).toBeNull();
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.parentId).toBe(pack.body.id);
    const mixedDepth = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, bottle.body.id], action: "parent", parentId: tent.body.id });
    expect(mixedDepth.status).toBe(200);
    expect(mixedDepth.body.tasks.find((task: { id: string }) => task.id === pack.body.id)).toMatchObject({
      id: pack.body.id,
      parentId: null,
      revision: pack.body.revision,
    });
    expect(mixedDepth.body.tasks.find((task: { id: string }) => task.id === bottle.body.id)).toMatchObject({
      parentId: tent.body.id,
      listId: trip.body.id,
      revision: bottle.body.revision + 1,
    });
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.parentId).toBe(pack.body.id);
    expect((await ada.patch(`/api/v1/tasks/${pack.body.id}`).send({ parentId: tent.body.id, revision: pack.body.revision })).status).toBe(400);
    const done = await ada.post("/api/v1/tasks").send({ title: "Done", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${done.body.id}/complete`)).status).toBe(200);
    const underDone = await ada.post("/api/v1/tasks/batch").send({ ids: [bottle.body.id], action: "parent", parentId: done.body.id });
    expect(underDone.status).toBe(200);
    expect(underDone.body.tasks[0]).toMatchObject({
      id: bottle.body.id,
      parentId: tent.body.id,
      revision: bottle.body.revision + 1,
    });
    expect((await ada.patch(`/api/v1/tasks/${bottle.body.id}`).send({
      parentId: done.body.id,
      revision: underDone.body.tasks[0].revision,
    })).status).toBe(400);
    const bottleAfter = await ada.get(`/api/v1/tasks/${bottle.body.id}`);
    const placed = await ada.post("/api/v1/tasks/batch").send({ ids: [bottle.body.id, cup.body.id], action: "parent", parentId: tent.body.id });
    expect(placed.status).toBe(200);
    expect(placed.body.tasks.find((task: { id: string }) => task.id === bottle.body.id)).toMatchObject({
      parentId: tent.body.id,
      listId: trip.body.id,
      revision: bottleAfter.body.task.revision,
    });
    expect(placed.body.tasks.find((task: { id: string }) => task.id === cup.body.id)).toMatchObject({
      parentId: tent.body.id,
      listId: trip.body.id,
      revision: cup.body.revision + 1,
    });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: home.body.id });
    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [lamp.body.id], action: "parent", parentId: tent.body.id });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks[0]).toMatchObject({ parentId: tent.body.id, listId: trip.body.id });
    const alone = await ada.post("/api/v1/tasks/batch").send({ ids: [bottle.body.id], action: "parent", parentId: null });
    expect(alone.status).toBe(200);
    expect(alone.body.tasks[0].parentId).toBeNull();
    const underSocks = await ada.post("/api/v1/tasks/batch").send({ ids: [cup.body.id], action: "parent", parentId: socks.body.id });
    expect(underSocks.status).toBe(200);
    expect(underSocks.body.tasks[0]).toMatchObject({
      id: cup.body.id,
      parentId: tent.body.id,
      revision: cup.body.revision + 1,
    });
    expect((await ada.patch(`/api/v1/tasks/${cup.body.id}`).send({
      parentId: socks.body.id,
      revision: underSocks.body.tasks[0].revision,
    })).status).toBe(400);
    expect(socks.status).toBe(201);
    expect(home.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [bottle.body.id], action: "parent", parentId: tent.body.id })).status).toBe(401);
  });

  it("adds a task at the end of a parent's subtasks and reorders those subtasks", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const errands = await ada.post("/api/v1/lists").send({ name: "Errands" });
    const home = await ada.post("/api/v1/lists").send({ name: "Home" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    expect((await ada.post(`/api/v1/lists/${errands.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: home.body.id });
    const joined = await ada.patch(`/api/v1/tasks/${lamp.body.id}`).send({ parentId: tent.body.id, revision: lamp.body.revision });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ parentId: tent.body.id, listId: trip.body.id });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", listId: home.body.id });
    const cup = await ada.post("/api/v1/tasks").send({ title: "Cup", listId: home.body.id });
    expect((await ada.post("/api/v1/tasks/batch").send({ ids: [bottle.body.id, cup.body.id], action: "parent", parentId: tent.body.id })).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { title: string }) => task.title)).toEqual([
      "Socks",
      "Lamp",
      "Bottle",
      "Cup",
    ]);
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: errands.body.id });
    expect((await grace.patch(`/api/v1/tasks/${pack.body.id}`).send({ parentId: tent.body.id, revision: pack.body.revision })).status).toBe(403);
    expect((await ada.get(`/api/v1/tasks/${pack.body.id}`)).body.task).toMatchObject({ parentId: null, listId: errands.body.id });
    const camera = await grace.post("/api/v1/tasks").send({ title: "Camera", listId: errands.body.id });
    const underTent = await grace.post("/api/v1/tasks/batch").send({
      ids: [pack.body.id, camera.body.id],
      action: "parent",
      parentId: tent.body.id,
    });
    expect(underTent.status).toBe(200);
    expect(underTent.body.tasks.find((task: { id: string }) => task.id === pack.body.id)).toMatchObject({
      id: pack.body.id,
      parentId: null,
      listId: errands.body.id,
      revision: pack.body.revision,
    });
    expect(underTent.body.tasks.find((task: { id: string }) => task.id === camera.body.id)).toMatchObject({
      parentId: tent.body.id,
      listId: trip.body.id,
      revision: camera.body.revision + 1,
    });
    const order = [cup.body.id, bottle.body.id, lamp.body.id, socks.body.id, camera.body.id];
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: order })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { id: string }) => task.id)).toEqual(order);
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: [cup.body.id, pack.body.id] })).status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { id: string }) => task.id)).toEqual(order);
    expect(socks.status).toBe(201);
    expect(home.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/reorder").send({ ids: order })).status).toBe(401);
  });

  it("names the parent on a subtask and rejects a partial subtask reorder", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", listId: trip.body.id, parentId: tent.body.id });
    const before = (await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { id: string }) => task.id);
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: [bottle.body.id, lamp.body.id] })).status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { id: string }) => task.id)).toEqual(before);
    const order = [bottle.body.id, lamp.body.id, socks.body.id];
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: order })).status).toBe(204);
    const detail = await ada.get(`/api/v1/tasks/${tent.body.id}`);
    expect(detail.body.subtasks.map((task: { id: string; parentTitle: string }) => [task.id, task.parentTitle])).toEqual([
      [bottle.body.id, "Tent"],
      [lamp.body.id, "Tent"],
      [socks.body.id, "Tent"],
    ]);
    const found = await ada.get("/api/v1/tasks?view=search&q=Socks");
    expect(found.body.tasks.map((task: { title: string; parentTitle: string }) => [task.title, task.parentTitle])).toEqual([["Socks", "Tent"]]);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.parentTitle).toBe("Tent");
    expect(tent.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=search&q=Socks")).status).toBe(401);
  });

  it("restores a subtask on its own when the parent is still in trash", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.delete(`/api/v1/tasks/${tent.body.id}`)).status).toBe(200);
    const broughtBack = await ada.post(`/api/v1/tasks/${tent.body.id}/restore`);
    expect(broughtBack.status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.parentId).toBe(tent.body.id);
    expect((await ada.get(`/api/v1/tasks/${lamp.body.id}`)).body.task.parentId).toBe(tent.body.id);
    expect((await ada.delete(`/api/v1/tasks/${tent.body.id}`)).status).toBe(200);
    const alone = await ada.post(`/api/v1/tasks/${socks.body.id}/restore`);
    expect(alone.status).toBe(200);
    expect(alone.body.parentId).toBeNull();
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Socks"]);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).status).toBe(404);
    expect((await ada.get("/api/v1/tasks?view=trash")).body.tasks.map((task: { title: string }) => task.title)).toEqual(expect.arrayContaining(["Tent", "Lamp"]));
    expect(lamp.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${socks.body.id}/restore`)).status).toBe(401);
  });

  it("reopens a finished parent when a subtask is reopened and deletes one subtask", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/complete`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${lamp.body.id}`)).body.task.status).toBe("completed");
    const reopened = await ada.post(`/api/v1/tasks/${socks.body.id}/uncomplete`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${lamp.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get("/api/v1/tasks?view=completed")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Lamp"]);
    expect((await ada.delete(`/api/v1/tasks/${lamp.body.id}`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Socks"]);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("open");
    expect(lamp.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${socks.body.id}/uncomplete`)).status).toBe(401);
  });

  it("adds a subtask at the end and duplicates it there", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Socks", "Lamp"]);
    const copy = await ada.post(`/api/v1/tasks/${lamp.body.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ title: "Lamp", parentId: tent.body.id, status: "open" });
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Socks", "Lamp", "Lamp"]);
    expect(socks.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${lamp.body.id}/duplicate`)).status).toBe(401);
  });

  it("counts open subtasks on the task and keeps a subtask due date", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id, dueAt: due, dueHasTime: true });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    const open = await ada.get(`/api/v1/tasks/${tent.body.id}`);
    expect(open.body.task).toMatchObject({ subtaskCount: 2, openSubtaskCount: 2 });
    expect(open.body.subtasks.find((task: { title: string }) => task.title === "Socks")).toMatchObject({ dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${lamp.body.id}/complete`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task).toMatchObject({ subtaskCount: 2, openSubtaskCount: 1 });
    expect(socks.status).toBe(201);
    expect((await request(app).get(`/api/v1/tasks/${tent.body.id}`)).status).toBe(401);
  });

  it("finishes open subtasks and appends a moved subtask", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const alpha = await ada.post("/api/v1/tasks").send({ title: "Alpha", listId: trip.body.id });
    const beta = await ada.post("/api/v1/tasks").send({ title: "Beta", listId: trip.body.id });
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: [alpha.body.id, beta.body.id] })).status).toBe(204);
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const rope = await ada.post("/api/v1/tasks").send({ title: "Rope", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${lamp.body.id}/archive`)).status).toBe(200);
    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [socks.body.id], action: "move", listId: trip.body.id });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks[0]).toMatchObject({ listId: trip.body.id, parentId: null });
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Tent", "Alpha", "Beta", "Socks"]);
    const finished = await ada.post(`/api/v1/tasks/${tent.body.id}/finish-subtasks`);
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ status: "open", subtaskCount: 2, openSubtaskCount: 0 });
    expect((await ada.get(`/api/v1/tasks/${rope.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${lamp.body.id}`)).body.task.status).toBe("archived");
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("open");
    const packed = await ada.post("/api/v1/lists").send({ name: "Packed" });
    const bag = await ada.post("/api/v1/tasks").send({ title: "Bag", listId: packed.body.id });
    expect((await ada.post(`/api/v1/tasks/${bag.body.id}/archive`)).status).toBe(200);
    const blocked = await ada.post(`/api/v1/tasks/${bag.body.id}/finish-subtasks`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("ARCHIVED");
    expect((await ada.get(`/api/v1/tasks/${bag.body.id}`)).body.task.status).toBe("archived");
    expect(rope.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${tent.body.id}/finish-subtasks`)).status).toBe(401);
  });

  it("restores an archived parent when one subtask is restored", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const lamp = await ada.post("/api/v1/tasks").send({ title: "Lamp", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/archive`)).status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("archived");
    expect((await ada.get(`/api/v1/tasks/${lamp.body.id}`)).body.task.status).toBe("archived");
    const restored = await ada.post(`/api/v1/tasks/${socks.body.id}/unarchive`);
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${lamp.body.id}`)).body.task.status).toBe("archived");
    expect((await ada.get("/api/v1/tasks?view=archived")).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Lamp"]);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Tent"]);
    expect(lamp.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${socks.body.id}/unarchive`)).status).toBe(401);
  });

  it("copies a subtask on its own when the parent is finished", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const alpha = await ada.post("/api/v1/tasks").send({ title: "Alpha", listId: trip.body.id });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/complete`)).status).toBe(200);
    const beta = await ada.post("/api/v1/tasks").send({ title: "Beta", listId: trip.body.id });
    const copy = await ada.post(`/api/v1/tasks/${socks.body.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ title: "Socks", parentId: null, status: "open", listId: trip.body.id });
    expect(copy.body.id).not.toBe(socks.body.id);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { title: string }) => task.title)).toEqual(["Beta", "Alpha", "Socks"]);
    expect(alpha.status).toBe(201);
    expect(beta.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${socks.body.id}/duplicate`)).status).toBe(401);
  });

  it("finds a finished task in search and names the parent in trash", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/complete`)).status).toBe(200);
    const found = await ada.get("/api/v1/tasks?view=search&q=Socks");
    expect(found.status).toBe(200);
    expect(found.body.tasks.map((task: { title: string; status: string }) => ({ title: task.title, status: task.status }))).toEqual([
      { title: "Socks", status: "completed" },
    ]);
    expect((await ada.delete(`/api/v1/tasks/${socks.body.id}`)).status).toBe(200);
    const trash = await ada.get("/api/v1/tasks?view=trash");
    expect(trash.body.tasks.find((task: { title: string }) => task.title === "Socks")).toMatchObject({ parentTitle: "Tent" });
    expect(tent.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=search&q=Socks")).status).toBe(401);
  });

  it("names the parent of an archived subtask", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/archive`)).status).toBe(200);
    const archived = await ada.get("/api/v1/tasks?view=archived");
    expect(archived.body.tasks.find((task: { title: string }) => task.title === "Socks")).toMatchObject({ parentTitle: "Tent", status: "archived" });
    expect(archived.body.tasks.find((task: { title: string }) => task.title === "Tent")).toBeUndefined();
    expect(tent.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=archived")).status).toBe(401);
  });

  it("includes a finished subtask on the calendar", async () => {
    const ada = await register("ada@example.com");
    const due = "2026-10-15T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", dueAt: due, dueHasTime: true });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", parentId: tent.body.id, dueAt: due, dueHasTime: true });
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/complete`)).status).toBe(200);
    const calendar = await ada.get("/api/v1/tasks?view=calendar&from=2026-10-15T00:00:00.000Z&to=2026-10-15T23:59:59.000Z");
    expect(calendar.status).toBe(200);
    expect(calendar.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Tent", status: "open" }),
        expect.objectContaining({ title: "Socks", status: "completed", parentTitle: "Tent" }),
      ]),
    );
    expect(socks.status).toBe(201);
    expect((await request(app).get("/api/v1/tasks?view=calendar&from=2026-10-15T00:00:00.000Z&to=2026-10-15T23:59:59.000Z")).status).toBe(401);
  });

  it("lists a token with its created time and hides the secret", async () => {
    const ada = await register("ada@example.com");
    const created = await ada.post("/api/v1/auth/tokens").send({ name: "Chrome" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^kx_/);
    const listed = await ada.get("/api/v1/auth/tokens");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: created.body.id, name: "Chrome", createdAt: created.body.createdAt }),
    ]);
    expect(listed.body[0].token).toBeUndefined();
    expect(Number.isNaN(Date.parse(listed.body[0].createdAt))).toBe(false);
    expect((await ada.delete(`/api/v1/auth/tokens/${created.body.id}`)).status).toBe(204);
    expect(await ada.get("/api/v1/auth/tokens")).toMatchObject({ status: 200, body: [] });
    expect((await ada.post(`/api/v1/auth/tokens/${created.body.id}/restore`)).status).toBe(200);
    expect((await ada.get("/api/v1/auth/tokens")).body).toEqual([
      expect.objectContaining({ id: created.body.id, name: "Chrome" }),
    ]);
    expect((await request(app).get("/api/v1/auth/tokens")).status).toBe(401);
  });

  it("lists a device with its created time and hides the push token", async () => {
    const ada = await register("ada@example.com");
    const subscription = browserSubscription("settings");
    const created = await ada.post("/api/v1/devices").send({ platform: "web", token: subscription });
    expect(created.status).toBe(201);
    expect(created.body.token).toBeUndefined();
    const listed = await ada.get("/api/v1/devices");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: created.body.id, platform: "web", createdAt: created.body.createdAt })]);
    expect(listed.body[0].token).toBeUndefined();
    expect(Number.isNaN(Date.parse(listed.body[0].createdAt))).toBe(false);
    const removed = await ada.delete(`/api/v1/devices/${created.body.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ platform: "web", token: subscription });
    expect(await ada.get("/api/v1/devices")).toMatchObject({ status: 200, body: [] });
    const restored = await ada.post("/api/v1/devices").send({ platform: "web", token: removed.body.token });
    expect(restored.status).toBe(201);
    expect((await ada.get("/api/v1/devices")).body).toEqual([
      expect.objectContaining({ id: restored.body.id, platform: "web" }),
    ]);
    expect((await request(app).get("/api/v1/devices")).status).toBe(401);
  });

  it("removes a deleted tag from someone else's task", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const camera = await grace.post("/api/v1/tasks").send({ title: "Camera", listId: trip.body.id });
    const travel = await ada.post("/api/v1/tags").send({ name: "Travel" });
    const tagged = await ada.post("/api/v1/tasks/batch").send({ ids: [camera.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" });
    expect(tagged.status).toBe(200);
    expect(tagged.body.tasks[0].tagIds).toEqual([travel.body.id]);
    expect((await ada.delete(`/api/v1/tags/${travel.body.id}`)).status).toBe(204);
    expect((await grace.get(`/api/v1/tasks/${camera.body.id}`)).body.task.tagIds).toEqual([]);
    expect(await ada.get("/api/v1/tags")).toMatchObject({ status: 200, body: [] });
    expect(camera.status).toBe(201);
    expect((await request(app).delete(`/api/v1/tags/${travel.body.id}`)).status).toBe(401);
  });

  it("restores a selected subtask when its deleted parent is restored", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const removed = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "delete" });
    expect(removed.status).toBe(200);
    expect(removed.body.tasks.map((task: { id: string }) => task.id)).toEqual([tent.body.id]);
    const brought = await ada.post(`/api/v1/tasks/${tent.body.id}/restore`);
    expect(brought.status).toBe(200);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task).toMatchObject({ parentId: tent.body.id, status: "open" });
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/restore`)).status).toBe(404);
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "delete" })).status).toBe(401);
  });

  it("keeps an archived list between the lists that swap around it", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const camp = await ada.post("/api/v1/lists").send({ name: "Camp" });
    const errands = await ada.post("/api/v1/lists").send({ name: "Errands" });
    expect((await ada.patch(`/api/v1/lists/${camp.body.id}`).send({ archived: true })).status).toBe(200);
    const swapped = await ada.post("/api/v1/lists/reorder").send({ ids: [errands.body.id, camp.body.id, trip.body.id] });
    expect(swapped.status).toBe(204);
    expect((await ada.get("/api/v1/lists")).body.map((list: { name: string }) => list.name)).toEqual(["Inbox", "Errands", "Camp", "Trip"]);
    expect(trip.status).toBe(201);
    expect((await request(app).post("/api/v1/lists/reorder").send({ ids: [errands.body.id, camp.body.id, trip.body.id] })).status).toBe(401);
  });

  it("leaves a list unchanged when the order is already that way", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    await ada.post("/api/v1/lists").send({ name: "Errands" });
    const before = await ada.get("/api/v1/lists");
    const movable = before.body.filter((list: { isInbox: boolean }) => !list.isInbox);
    const ids = movable.map((list: { id: string }) => list.id);
    expect((await ada.post("/api/v1/lists/reorder").send({ ids })).status).toBe(204);
    const same = await ada.get("/api/v1/lists");
    expect(same.body.map((list: { id: string; sortOrder: number }) => [list.id, list.sortOrder])).toEqual(
      before.body.map((list: { id: string; sortOrder: number }) => [list.id, list.sortOrder]),
    );
    const swapped = [...ids].reverse();
    expect((await ada.post("/api/v1/lists/reorder").send({ ids: swapped })).status).toBe(204);
    const moved = await ada.get("/api/v1/lists");
    expect(moved.body.filter((list: { isInbox: boolean }) => !list.isInbox).map((list: { id: string }) => list.id)).toEqual(swapped);
    expect((await ada.post("/api/v1/lists/reorder").send({ ids: swapped })).status).toBe(204);
    const again = await ada.get("/api/v1/lists");
    expect(again.body.map((list: { id: string; sortOrder: number }) => [list.id, list.sortOrder])).toEqual(
      moved.body.map((list: { id: string; sortOrder: number }) => [list.id, list.sortOrder]),
    );
    expect(trip.status).toBe(201);
    expect((await request(app).post("/api/v1/lists/reorder").send({ ids: swapped })).status).toBe(401);
  });

  it("rejects unarchiving a parent that a subtask already restored", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/archive`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/unarchive`)).status).toBe(200);
    const afterChild = await ada.get(`/api/v1/tasks/${tent.body.id}`);
    expect(afterChild.body.task.status).toBe("open");
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/unarchive`)).status).toBe(400);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "unarchive" });
    expect(again.status).toBe(200);
    expect(again.body.tasks[0]).toMatchObject({ id: tent.body.id, status: "open", revision: afterChild.body.task.revision });
    expect(socks.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${tent.body.id}/unarchive`)).status).toBe(401);
  });

  it("leaves finished subtasks finished when an open task is reopened", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/complete`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/uncomplete`)).status).toBe(400);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("open");
    expect(socks.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${tent.body.id}/uncomplete`)).status).toBe(401);
  });

  it("rejects deleting a subtask forever after its parent was deleted forever", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.delete(`/api/v1/tasks/${tent.body.id}`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/purge`)).status).toBe(200);
    expect((await ada.post(`/api/v1/tasks/${socks.body.id}/purge`)).status).toBe(404);
    expect((await ada.get("/api/v1/tasks?view=trash")).body.tasks).toEqual([]);
    expect(socks.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${tent.body.id}/purge`)).status).toBe(401);
  });

  it("archives a selected subtask once with its parent", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const archived = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "archive" });
    expect(archived.status).toBe(200);
    expect(archived.body.tasks.map((task: { id: string }) => task.id)).toEqual([tent.body.id]);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("archived");
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "archive" })).status).toBe(401);
  });

  it("postpones a selected subtask when its repeating parent does not carry it", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({
      title: "Tent",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const postponed = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "postpone" });
    expect(postponed.status).toBe(200);
    expect(postponed.body.tasks).toHaveLength(2);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.dueAt).not.toBeNull();
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.dueAt).not.toBe(due);
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "postpone" })).status).toBe(401);
  });

  it("moves a selected subtask once with its parent", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const inbox = (await ada.get("/api/v1/lists")).body.find((list: { isInbox: boolean }) => list.isInbox).id;
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "move", listId: inbox });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks.map((task: { id: string }) => task.id)).toEqual([tent.body.id]);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task).toMatchObject({ listId: inbox, parentId: tent.body.id });
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "move", listId: inbox })).status).toBe(401);
  });

  it("reopens an unselected finished subtask with its parent and leaves siblings when only a subtask is reopened", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/complete`)).status).toBe(200);
    const withParent = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "reopen" });
    expect(withParent.status).toBe(200);
    expect(withParent.body.tasks.map((task: { id: string }) => task.id)).toEqual([tent.body.id]);
    expect((await ada.get(`/api/v1/tasks/${hat.body.id}`)).body.task.status).toBe("open");
    expect((await ada.post(`/api/v1/tasks/${tent.body.id}/complete`)).status).toBe(200);
    const childOnly = await ada.post("/api/v1/tasks/batch").send({ ids: [socks.body.id], action: "reopen" });
    expect(childOnly.status).toBe(200);
    expect(childOnly.body.tasks.map((task: { id: string }) => task.id)).toEqual([socks.body.id]);
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("open");
    expect((await ada.get(`/api/v1/tasks/${hat.body.id}`)).body.task.status).toBe("completed");
    expect(hat.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "reopen" })).status).toBe(401);
  });

  it("detaches someone else's subtask when its task is deleted forever", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const socks = await grace.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.delete(`/api/v1/tasks/${tent.body.id}`)).status).toBe(200);
    const purged = await ada.post(`/api/v1/tasks/${tent.body.id}/purge`);
    expect(purged.status).toBe(200);
    expect(purged.body).toEqual({ deletedIds: [tent.body.id], detachedIds: [socks.body.id] });
    const trash = await grace.get("/api/v1/tasks?view=trash");
    expect(trash.body.tasks.find((task: { id: string }) => task.id === socks.body.id)).toMatchObject({ parentId: null, title: "Socks" });
    expect(socks.status).toBe(201);
    expect((await request(app).post(`/api/v1/tasks/${tent.body.id}/purge`)).status).toBe(401);
  });

  it("completes a selected subtask when its repeating parent does not finish it", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const due = "2026-10-15T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({
      title: "Tent",
      listId: trip.body.id,
      dueAt: due,
      dueHasTime: true,
      recurrence: { frequency: "daily", interval: 1 },
    });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const completed = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "complete" });
    expect(completed.status).toBe(200);
    expect(completed.body.tasks).toHaveLength(2);
    expect((await ada.get(`/api/v1/tasks/${socks.body.id}`)).body.task.status).toBe("completed");
    expect((await ada.get(`/api/v1/tasks/${tent.body.id}`)).body.task.status).toBe("open");
    expect(socks.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "complete" })).status).toBe(401);
  });

  it("counts the subtasks copied with a selection and leaves an archived subtask out", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id, parentId: tent.body.id });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: tent.body.id });
    expect((await ada.post(`/api/v1/tasks/${hat.body.id}/archive`)).status).toBe(200);
    const copied = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "duplicate" });
    expect(copied.status).toBe(200);
    expect(copied.body.tasks).toHaveLength(1);
    expect(copied.body.tasks[0].subtaskCount).toBe(1);
    expect((await ada.get(`/api/v1/tasks/${copied.body.tasks[0].id}`)).body.subtasks.map((task: { title: string }) => task.title)).toEqual(["Socks"]);
    expect(hat.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "duplicate" })).status).toBe(401);
  });

  it("leaves an already pinned task unchanged when the selection is pinned again", async () => {
    const ada = await register("ada@example.com");
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "pin", pinned: true });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "pin", pinned: true });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ pinned: true, revision: first.body.tasks[0].revision });
    expect(socksAgain).toMatchObject({ pinned: true, revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "pin", pinned: true })).status).toBe(401);
  });

  it("leaves an already assigned task unchanged when the selection is assigned again", async () => {
    const ada = await register("ada@example.com");
    const grace = await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    expect((await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(201);
    const graceId = (await grace.get("/api/v1/me")).body.id as string;
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: trip.body.id });
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "assign", assigneeId: graceId });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "assign", assigneeId: graceId });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ assigneeId: graceId, revision: first.body.tasks[0].revision });
    expect(socksAgain).toMatchObject({ assigneeId: graceId, revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "assign", assigneeId: null })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that tag", async () => {
    const ada = await register("ada@example.com");
    const travel = await ada.post("/api/v1/tags").send({ name: "Travel" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ tagIds: [travel.body.id], revision: first.body.tasks[0].revision });
    expect(socksAgain).toMatchObject({ tagIds: [travel.body.id], revision: socks.body.revision + 1 });
    expect(travel.status).toBe(201);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "tag", tagId: travel.body.id, tagMode: "add" })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that estimate", async () => {
    const ada = await register("ada@example.com");
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "estimate", estimatedMinutes: 30 });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "estimate", estimatedMinutes: 30 });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ estimatedMinutes: 30, revision: first.body.tasks[0].revision });
    expect(socksAgain).toMatchObject({ estimatedMinutes: 30, revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "estimate", estimatedMinutes: 30 })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that start date", async () => {
    const ada = await register("ada@example.com");
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const start = "2026-11-01T00:00:00.000Z";
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "start", startAt: start });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "start", startAt: start });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ startAt: start, revision: first.body.tasks[0].revision });
    expect(socksAgain).toMatchObject({ startAt: start, revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "start", startAt: start })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that repeat rule", async () => {
    const ada = await register("ada@example.com");
    const due = "2026-11-02T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", dueAt: due, dueHasTime: true });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", dueAt: due, dueHasTime: true });
    const rule = { frequency: "daily", interval: 1 };
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "repeat", recurrence: rule });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "repeat", recurrence: rule });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ revision: first.body.tasks[0].revision });
    expect(tentAgain.recurrence).toMatchObject(rule);
    expect(socksAgain).toMatchObject({ revision: socks.body.revision + 1 });
    expect(socksAgain.recurrence).toMatchObject(rule);
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "repeat", recurrence: rule })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that reminder", async () => {
    const ada = await register("ada@example.com");
    const due = "2026-11-02T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", dueAt: due, dueHasTime: true });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", dueAt: due, dueHasTime: true });
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "remind", reminderOffsetMinutes: 15 });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "remind", reminderOffsetMinutes: 15 });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ reminderOffsetMinutes: 15, revision: first.body.tasks[0].revision });
    expect(socksAgain).toMatchObject({ reminderOffsetMinutes: 15, revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "remind", reminderOffsetMinutes: 15 })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that priority", async () => {
    const ada = await register("ada@example.com");
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", priority: "high" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "priority", priority: "high" });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ priority: "high", revision: tent.body.revision });
    expect(socksAgain).toMatchObject({ priority: "high", revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "priority", priority: "high" })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that date", async () => {
    const ada = await register("ada@example.com");
    const due = "2026-11-02T15:00:00.000Z";
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", dueAt: due, dueHasTime: true });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "due", dueAt: due, dueHasTime: true });
    expect(again.status).toBe(200);
    const tentAgain = again.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ dueAt: due, dueHasTime: true, revision: tent.body.revision });
    expect(socksAgain).toMatchObject({ dueAt: due, dueHasTime: true, revision: socks.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "due", dueAt: due, dueHasTime: true })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection already has that parent", async () => {
    const ada = await register("ada@example.com");
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent" });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks" });
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat" });
    const first = await ada.post("/api/v1/tasks/batch").send({ ids: [socks.body.id], action: "parent", parentId: tent.body.id });
    expect(first.status).toBe(200);
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [socks.body.id, hat.body.id], action: "parent", parentId: tent.body.id });
    expect(again.status).toBe(200);
    const socksAgain = again.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    const hatAgain = again.body.tasks.find((task: { id: string }) => task.id === hat.body.id);
    expect(socksAgain).toMatchObject({ parentId: tent.body.id, revision: first.body.tasks[0].revision });
    expect(hatAgain).toMatchObject({ parentId: tent.body.id, revision: hat.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [socks.body.id], action: "parent", parentId: tent.body.id })).status).toBe(401);
  });

  it("leaves a task unchanged when the selection is already on that list", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const home = await ada.post("/api/v1/lists").send({ name: "Home" });
    const tent = await ada.post("/api/v1/tasks").send({ title: "Tent", listId: trip.body.id });
    const socks = await ada.post("/api/v1/tasks").send({ title: "Socks", listId: home.body.id });
    const bottle = await ada.post("/api/v1/tasks").send({ title: "Bottle", listId: trip.body.id, parentId: tent.body.id });
    const moved = await ada.post("/api/v1/tasks/batch").send({ ids: [tent.body.id, socks.body.id], action: "move", listId: trip.body.id });
    expect(moved.status).toBe(200);
    const tentAgain = moved.body.tasks.find((task: { id: string }) => task.id === tent.body.id);
    const socksAgain = moved.body.tasks.find((task: { id: string }) => task.id === socks.body.id);
    expect(tentAgain).toMatchObject({ listId: trip.body.id, revision: tent.body.revision });
    expect(socksAgain).toMatchObject({ listId: trip.body.id, revision: socks.body.revision + 1 });
    expect((await ada.get(`/api/v1/tasks/${bottle.body.id}`)).body.task.revision).toBe(bottle.body.revision);
    const hat = await ada.post("/api/v1/tasks").send({ title: "Hat", listId: trip.body.id, parentId: tent.body.id });
    const detached = await ada.post("/api/v1/tasks/batch").send({ ids: [hat.body.id], action: "move", listId: trip.body.id });
    expect(detached.status).toBe(200);
    expect(detached.body.tasks[0]).toMatchObject({ listId: trip.body.id, parentId: null, revision: hat.body.revision + 1 });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [tent.body.id], action: "move", listId: trip.body.id })).status).toBe(401);
  });

  it("leaves tasks unchanged when the list is already sorted that way", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const banana = await ada.post("/api/v1/tasks").send({ title: "Banana", listId: trip.body.id, dueAt: "2026-10-01T12:00:00.000Z", dueHasTime: true });
    const apple = await ada.post("/api/v1/tasks").send({ title: "Apple", listId: trip.body.id, dueAt: "2026-10-20T12:00:00.000Z", dueHasTime: true });
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "title" })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks/${apple.body.id}`)).body.task.revision).toBe(apple.body.revision);
    expect((await ada.get(`/api/v1/tasks/${banana.body.id}`)).body.task.revision).toBe(banana.body.revision);
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "due" })).status).toBe(204);
    const afterDue = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`);
    expect(afterDue.body.tasks.map((task: { title: string }) => task.title)).toEqual(["Banana", "Apple"]);
    expect((await ada.post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "due" })).status).toBe(204);
    const again = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`);
    expect(again.body.tasks.map((task: { id: string; revision: number }) => task.revision)).toEqual(
      afterDue.body.tasks.map((task: { revision: number }) => task.revision),
    );
    expect((await request(app).post("/api/v1/tasks/sort").send({ listId: trip.body.id, by: "title" })).status).toBe(401);
  });

  it("leaves a task unchanged when the order is already that way", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const alpha = await ada.post("/api/v1/tasks").send({ title: "Alpha", listId: trip.body.id });
    const beta = await ada.post("/api/v1/tasks").send({ title: "Beta", listId: trip.body.id });
    const current = [beta.body.id, alpha.body.id];
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: current })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks/${alpha.body.id}`)).body.task.revision).toBe(alpha.body.revision);
    expect((await ada.get(`/api/v1/tasks/${beta.body.id}`)).body.task.revision).toBe(beta.body.revision);
    const swapped = [alpha.body.id, beta.body.id];
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: swapped })).status).toBe(204);
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`)).body.tasks.map((task: { id: string }) => task.id)).toEqual(swapped);
    const after = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`);
    expect((await ada.post("/api/v1/tasks/reorder").send({ ids: swapped })).status).toBe(204);
    const again = await ada.get(`/api/v1/tasks?view=list&listId=${trip.body.id}`);
    expect(again.body.tasks.map((task: { revision: number }) => task.revision)).toEqual(after.body.tasks.map((task: { revision: number }) => task.revision));
    expect((await request(app).post("/api/v1/tasks/reorder").send({ ids: swapped })).status).toBe(401);
  });

  it("leaves a tag unchanged when it already has that name and color", async () => {
    const ada = await register("ada@example.com");
    const travel = await ada.post("/api/v1/tags").send({ name: "Travel", color: "sea" });
    const before = await Tag.findById(travel.body.id);
    const same = await ada.patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Travel", color: "sea" });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ name: "Travel", color: "sea" });
    expect((await Tag.findById(travel.body.id))?.updatedAt?.toISOString()).toBe(before?.updatedAt?.toISOString());
    const renamed = await ada.patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Luggage" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Luggage", color: "sea" });
    const afterName = await Tag.findById(travel.body.id);
    expect(afterName?.updatedAt?.getTime()).toBeGreaterThan(before?.updatedAt?.getTime() ?? 0);
    const again = await ada.patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Luggage", color: "sea" });
    expect(again.status).toBe(200);
    expect((await Tag.findById(travel.body.id))?.updatedAt?.toISOString()).toBe(afterName?.updatedAt?.toISOString());
    const recolored = await ada.patch(`/api/v1/tags/${travel.body.id}`).send({ color: "plum" });
    expect(recolored.body).toMatchObject({ name: "Luggage", color: "plum" });
    expect((await request(app).patch(`/api/v1/tags/${travel.body.id}`).send({ name: "Luggage", color: "plum" })).status).toBe(401);
  });

  it("leaves a list unchanged when it already has that name, color, and icon", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip", color: "sea", icon: "plane" });
    const before = await List.findById(trip.body.id);
    const same = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ name: "Trip", color: "sea", icon: "plane" });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ name: "Trip", color: "sea", icon: "plane" });
    expect((await List.findById(trip.body.id))?.updatedAt?.toISOString()).toBe(before?.updatedAt?.toISOString());
    const recolored = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ color: "gold" });
    expect(recolored.body).toMatchObject({ name: "Trip", color: "gold", icon: "plane" });
    const afterColor = await List.findById(trip.body.id);
    expect(afterColor?.updatedAt?.getTime()).toBeGreaterThan(before?.updatedAt?.getTime() ?? 0);
    const again = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ name: "Trip", color: "gold", icon: "plane" });
    expect(again.status).toBe(200);
    expect((await List.findById(trip.body.id))?.updatedAt?.toISOString()).toBe(afterColor?.updatedAt?.toISOString());
    const archived = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: true });
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    const archivedAgain = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: true });
    expect(archivedAgain.body.archivedAt).toBe(archived.body.archivedAt);
    const restored = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: false });
    expect(restored.body.archivedAt).toBeNull();
    const afterRestore = await List.findById(trip.body.id);
    const restoredAgain = await ada.patch(`/api/v1/lists/${trip.body.id}`).send({ archived: false });
    expect(restoredAgain.body.archivedAt).toBeNull();
    expect((await List.findById(trip.body.id))?.updatedAt?.toISOString()).toBe(afterRestore?.updatedAt?.toISOString());
    expect((await request(app).patch(`/api/v1/lists/${trip.body.id}`).send({ name: "Trip" })).status).toBe(401);
  });

  it("leaves a profile unchanged when the settings already match", async () => {
    const ada = await register("ada@example.com");
    const before = await User.findOne({ email: "ada@example.com" });
    const same = await ada.patch("/api/v1/me").send({
      name: "Ada Lovelace",
      timeZone: "UTC",
      emailReminders: false,
      pushReminders: false,
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ name: "Ada Lovelace", timeZone: "UTC", emailReminders: false, pushReminders: false, plan: "personal" });
    expect((await User.findById(before?._id))?.updatedAt?.toISOString()).toBe(before?.updatedAt?.toISOString());
    const renamed = await ada.patch("/api/v1/me").send({ name: "Ada" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Ada");
    const afterName = await User.findById(before?._id);
    expect(afterName?.updatedAt?.getTime()).toBeGreaterThan(before?.updatedAt?.getTime() ?? 0);
    const again = await ada.patch("/api/v1/me").send({ name: "Ada", timeZone: "UTC", emailReminders: false, pushReminders: false });
    expect(again.status).toBe(200);
    expect((await User.findById(before?._id))?.updatedAt?.toISOString()).toBe(afterName?.updatedAt?.toISOString());
    const zone = await ada.patch("/api/v1/me").send({ timeZone: "America/New_York" });
    expect(zone.body.timeZone).toBe("America/New_York");
    const mail = await ada.patch("/api/v1/me").send({ emailReminders: true });
    expect(mail.body.emailReminders).toBe(true);
    expect((await request(app).patch("/api/v1/me").send({ name: "Ada" })).status).toBe(401);
  });

  it("leaves a member in place when they are already on the list", async () => {
    const ada = await register("ada@example.com");
    await register("grace@example.com", "Grace Hopper");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const invited = await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({ email: "grace@example.com", role: "editor", added: true });
    const members = await ada.get(`/api/v1/lists/${trip.body.id}/members`);
    const again = await ada.post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "Grace@Example.com" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: invited.body.id, email: "grace@example.com", role: "editor", added: false });
    expect((await ada.get(`/api/v1/lists/${trip.body.id}/members`)).body).toEqual(members.body);
    expect((await request(app).post(`/api/v1/lists/${trip.body.id}/members`).send({ email: "grace@example.com" })).status).toBe(401);
  });

  it("leaves an archived task unchanged when the selection archives again", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: trip.body.id });
    const archived = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "archive" });
    expect(archived.status).toBe(200);
    expect(archived.body.tasks[0].status).toBe("archived");
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, milk.body.id], action: "archive" });
    expect(again.status).toBe(200);
    expect(again.body.tasks).toHaveLength(2);
    expect(again.body.tasks.find((task: { id: string }) => task.id === pack.body.id)).toMatchObject({
      status: "archived",
      revision: archived.body.tasks[0].revision,
    });
    expect(again.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      status: "archived",
      revision: milk.body.revision + 1,
    });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "archive" })).status).toBe(401);
  });

  it("leaves a completed task unchanged when the selection completes again", async () => {
    const ada = await register("ada@example.com");
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack" });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk" });
    const done = await ada.post(`/api/v1/tasks/${pack.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    const twice = await ada.post(`/api/v1/tasks/${pack.body.id}/complete`);
    expect(twice.body).toMatchObject({ status: "completed", revision: done.body.revision, completedAt: done.body.completedAt });
    const again = await ada.post("/api/v1/tasks/batch").send({ ids: [pack.body.id, milk.body.id], action: "complete" });
    expect(again.status).toBe(200);
    expect(again.body.tasks.find((task: { id: string }) => task.id === pack.body.id)).toMatchObject({
      status: "completed",
      revision: done.body.revision,
      completedAt: done.body.completedAt,
    });
    expect(again.body.tasks.find((task: { id: string }) => task.id === milk.body.id)).toMatchObject({
      status: "completed",
      revision: milk.body.revision + 1,
    });
    expect((await request(app).post("/api/v1/tasks/batch").send({ ids: [pack.body.id], action: "complete" })).status).toBe(401);
  });

  it("leaves a task unchanged when the saved details already match", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({
      title: "Pack",
      listId: trip.body.id,
      description: "Clothes",
      priority: "high",
      dueAt: "2026-10-20T15:00:00.000Z",
      dueHasTime: true,
    });
    const same = await ada.patch(`/api/v1/tasks/${pack.body.id}`).send({
      title: "Pack",
      description: "Clothes",
      listId: trip.body.id,
      priority: "high",
      dueAt: "2026-10-20T15:00:00.000Z",
      dueHasTime: true,
      startAt: null,
      tagIds: [],
      estimatedMinutes: null,
      reminderOffsetMinutes: null,
      recurrence: null,
      revision: pack.body.revision,
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ title: "Pack", revision: pack.body.revision, description: "Clothes", priority: "high" });
    const renamed = await ada.patch(`/api/v1/tasks/${pack.body.id}`).send({ title: "Bags", revision: pack.body.revision });
    expect(renamed.body).toMatchObject({ title: "Bags", revision: pack.body.revision + 1 });
    const again = await ada.patch(`/api/v1/tasks/${pack.body.id}`).send({ title: "Bags", revision: renamed.body.revision });
    expect(again.body.revision).toBe(renamed.body.revision);
    expect((await request(app).patch(`/api/v1/tasks/${pack.body.id}`).send({ title: "Bags", revision: renamed.body.revision })).status).toBe(401);
  });

  it("copies a list and says when there are no open tasks to copy", async () => {
    const ada = await register("ada@example.com");
    const trip = await ada.post("/api/v1/lists").send({ name: "Trip" });
    const pack = await ada.post("/api/v1/tasks").send({ title: "Pack", listId: trip.body.id });
    expect((await ada.post(`/api/v1/tasks/${pack.body.id}/archive`)).status).toBe(200);
    const empty = await ada.post(`/api/v1/lists/${trip.body.id}/duplicate`);
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ name: "Trip copy", copiedTasks: 0 });
    expect((await ada.get(`/api/v1/tasks?view=list&listId=${empty.body.id}`)).body.tasks).toEqual([]);
    const errands = await ada.post("/api/v1/lists").send({ name: "Errands" });
    const milk = await ada.post("/api/v1/tasks").send({ title: "Milk", listId: errands.body.id });
    const filled = await ada.post(`/api/v1/lists/${errands.body.id}/duplicate`);
    expect(filled.body).toMatchObject({ name: "Errands copy", copiedTasks: 1 });
    expect(milk.status).toBe(201);
    expect((await request(app).post(`/api/v1/lists/${trip.body.id}/duplicate`)).status).toBe(401);
  });
});
