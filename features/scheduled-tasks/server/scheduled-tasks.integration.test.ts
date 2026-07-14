import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertSettings } from "@/features/settings/server/repository";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";

import {
  getRecentDeliveries,
  listDueScheduledTasks,
  markScheduledTaskRun,
  nextRecentDeliveries,
} from "./repository";
import {
  createScheduledTaskService,
  editScheduledTaskService,
  findTasks,
  getScheduledTasks,
  removeScheduledTaskService,
} from "./service";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "dashboard" } as const;

const base = {
  chatId: "555",
  instruction: "call mom",
  scheduleKind: "daily" as const,
  timeOfDay: "09:00",
};

describe("createScheduledTaskService", () => {
  it("creates a daily task with a computed next run and records a trace", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    expect(task.id).toBeTruthy();
    expect(task).toMatchObject({
      chatId: "555",
      instruction: "call mom",
      scheduleKind: "daily",
      timeOfDay: "09:00",
      enabled: true,
    });
    expect(task.nextRunAt).not.toBeNull();
    // Next run is at 09:00 UTC (today or tomorrow) — the minutes/seconds land on :00.
    expect(new Date(task.nextRunAt!).getUTCMinutes()).toBe(0);
    expect(new Date(task.nextRunAt!).getUTCHours()).toBe(9);

    const traces = await listTraces(ctx.db, { feature: "scheduled-tasks" });
    expect(traces.traces[0]).toMatchObject({ action: "create", status: "success" });

    const all = await getScheduledTasks("555", ctx.db);
    expect(all).toHaveLength(1);
  });

  it("interprets the schedule in the configured operator timezone", async () => {
    await upsertSettings(ctx.db, { timezone: "Asia/Tokyo" });
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    // 09:00 in Tokyo (UTC+9) is 00:00Z — the next-run instant is stored in UTC.
    expect(new Date(task.nextRunAt!).getUTCHours()).toBe(0);
  });

  it("records the author (createdByUserId) on the task", async () => {
    const task = await createScheduledTaskService(
      { ...base, createdByUserId: "100" },
      trigger,
      ctx.db,
    );
    expect(task.createdByUserId).toBe("100");
  });

  it("rejects a weekly task with no weekdays and a past one-shot", async () => {
    await expect(
      createScheduledTaskService(
        { ...base, scheduleKind: "weekly", weekdays: [] },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/weekday/i);
    await expect(
      createScheduledTaskService(
        { ...base, scheduleKind: "once", timeOfDay: "09:00", runDate: "2000-01-01" },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/past/i);
  });
});

describe("editScheduledTaskService", () => {
  it("recomputes the next run and disabling clears it", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    const disabled = await editScheduledTaskService(task.id, { enabled: false }, trigger, ctx.db);
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();

    const reenabled = await editScheduledTaskService(
      task.id,
      { enabled: true, timeOfDay: "10:30" },
      trigger,
      ctx.db,
    );
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.timeOfDay).toBe("10:30");
    expect(new Date(reenabled.nextRunAt!).getUTCHours()).toBe(10);
  });

  it("rejects an unknown id", async () => {
    await expect(
      editScheduledTaskService("nope", { enabled: false }, trigger, ctx.db),
    ).rejects.toThrow(/unknown task/i);
  });
});

describe("removeScheduledTaskService", () => {
  it("deletes and traces", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    await removeScheduledTaskService(task.id, trigger, ctx.db);
    expect(await getScheduledTasks("555", ctx.db)).toHaveLength(0);
    await expect(removeScheduledTaskService(task.id, trigger, ctx.db)).rejects.toThrow(/unknown/i);
  });
});

describe("findTasks", () => {
  it("substring-matches instructions within a chat", async () => {
    await createScheduledTaskService({ ...base, instruction: "call mom" }, trigger, ctx.db);
    await createScheduledTaskService({ ...base, instruction: "water plants" }, trigger, ctx.db);
    await createScheduledTaskService(
      { ...base, chatId: "777", instruction: "call mom" },
      trigger,
      ctx.db,
    );
    const inChat = await findTasks("call", "555", ctx.db);
    expect(inChat).toHaveLength(1);
    const everywhere = await findTasks("call", undefined, ctx.db);
    expect(everywhere).toHaveLength(2);
  });
});

describe("due scan + markScheduledTaskRun", () => {
  it("lists only enabled due tasks and advancing updates run state + capped deliveries", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    // Not due yet (next run is in the future).
    expect(await listDueScheduledTasks(ctx.db, new Date())).toHaveLength(0);
    // Due when we ask from far in the future.
    const future = new Date(Date.now() + 3 * 86_400_000);
    const due = await listDueScheduledTasks(ctx.db, future);
    expect(due.map((t) => t.id)).toContain(task.id);

    // Advance with a delivery; recentDeliveries keeps newest-first, capped at 5.
    let recent = await getRecentDeliveries(ctx.db, task.id);
    for (let i = 1; i <= 6; i += 1) {
      recent = nextRecentDeliveries(recent, `msg ${i}`);
      await markScheduledTaskRun(ctx.db, task.id, {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + 86_400_000),
        recentDeliveries: recent,
      });
    }
    const stored = await getRecentDeliveries(ctx.db, task.id);
    expect(stored).toEqual(["msg 6", "msg 5", "msg 4", "msg 3", "msg 2"]);

    // A null next run disables the task.
    await markScheduledTaskRun(ctx.db, task.id, { lastRunAt: new Date(), nextRunAt: null });
    const after = await getScheduledTasks("555", ctx.db);
    expect(after[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });
});
