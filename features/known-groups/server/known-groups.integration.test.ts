import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setKnownUserAliases, upsertKnownUser } from "@/features/known-users/server/repository";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";
import { getGroupMembers, getKnownGroup } from "./repository";
import {
  getGroupContext,
  getGroupWithMembers,
  listGroups,
  rememberGroupActivity,
  updateNotes,
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

/** Seed a known user so the membership FK is satisfiable. */
async function seedUser(profile: {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}) {
  await upsertKnownUser(ctx.db, profile);
}

describe("rememberGroupActivity", () => {
  it("captures a group + member on first message and refreshes the title without touching notes", async () => {
    await seedUser({ userId: "1", username: "ann", firstName: "Ann", lastName: null });
    await rememberGroupActivity(
      { chatId: "-100", title: "Team", type: "supergroup", userId: "1" },
      ctx.db,
    );
    await updateNotes("-100", { notes: "Work group" }, trigger, ctx.db);

    // A later message with a renamed group refreshes the title but keeps notes.
    await rememberGroupActivity(
      { chatId: "-100", title: "Team (renamed)", type: "supergroup", userId: "1" },
      ctx.db,
    );

    const group = await getKnownGroup(ctx.db, "-100");
    expect(group).toMatchObject({ chatId: "-100", title: "Team (renamed)", notes: "Work group" });

    const members = await getGroupMembers(ctx.db, "-100");
    expect(members.map((m) => m.userId)).toEqual(["1"]);
  });

  it("records membership only for the group the user spoke in", async () => {
    await seedUser({ userId: "1", username: "ann", firstName: "Ann", lastName: null });
    await rememberGroupActivity({ chatId: "-1", title: "A", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-2", title: "B", type: "group", userId: null }, ctx.db);

    expect((await getGroupMembers(ctx.db, "-1")).map((m) => m.userId)).toEqual(["1"]);
    expect(await getGroupMembers(ctx.db, "-2")).toEqual([]);
  });
});

describe("listGroups", () => {
  it("returns groups most-recently-seen first with member counts", async () => {
    await seedUser({ userId: "1", username: "a", firstName: null, lastName: null });
    await seedUser({ userId: "2", username: "b", firstName: null, lastName: null });
    await rememberGroupActivity({ chatId: "-1", title: "First", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-2", title: "Second", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-2", title: "Second", type: "group", userId: "2" }, ctx.db);

    const groups = await listGroups(ctx.db);
    expect(groups.map((g) => g.chatId)).toEqual(["-2", "-1"]);
    const second = groups.find((g) => g.chatId === "-2");
    expect(second?.memberCount).toBe(2);
  });
});

describe("getGroupWithMembers", () => {
  it("returns the group and its members, most-recently-active first", async () => {
    await seedUser({ userId: "1", username: "ann", firstName: "Ann", lastName: null });
    await seedUser({ userId: "2", username: "bob", firstName: "Bob", lastName: null });
    await rememberGroupActivity({ chatId: "-1", title: "G", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-1", title: "G", type: "group", userId: "2" }, ctx.db);

    const detail = await getGroupWithMembers("-1", ctx.db);
    expect(detail?.group.chatId).toBe("-1");
    // Bob spoke last, so he is first.
    expect(detail?.members.map((m) => m.userId)).toEqual(["2", "1"]);
  });

  it("returns null for an unknown group", async () => {
    expect(await getGroupWithMembers("-404", ctx.db)).toBeNull();
  });
});

describe("updateNotes", () => {
  it("sets and clears notes, recording a trace each time", async () => {
    await rememberGroupActivity({ chatId: "-1", title: "G", type: "group", userId: null }, ctx.db);

    const set = await updateNotes("-1", { notes: "Casual" }, trigger, ctx.db);
    expect(set.notes).toBe("Casual");
    const cleared = await updateNotes("-1", { notes: null }, trigger, ctx.db);
    expect(cleared.notes).toBeNull();

    const { traces } = await listTraces(ctx.db, { feature: "known-groups" });
    expect(traces).toHaveLength(2);
    expect(traces.every((t) => t.action === "update-notes" && t.status === "success")).toBe(true);
  });

  it("fails for an unknown group and records an error trace", async () => {
    await expect(updateNotes("-404", { notes: "x" }, trigger, ctx.db)).rejects.toThrow(
      /unknown group/i,
    );
    const { traces } = await listTraces(ctx.db, { feature: "known-groups" });
    expect(traces[0].status).toBe("error");
  });
});

describe("getGroupContext", () => {
  it("builds a roster block with member labels, aliases, and notes", async () => {
    await seedUser({ userId: "1", username: "drumslave", firstName: "George", lastName: null });
    await setKnownUserAliases(ctx.db, "1", ["Dad", "Boss"]);
    await seedUser({ userId: "2", username: null, firstName: "Alice", lastName: "Smith" });
    await rememberGroupActivity({ chatId: "-1", title: "Family", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-1", title: "Family", type: "group", userId: "2" }, ctx.db);
    await updateNotes("-1", { notes: "Keep it casual" }, trigger, ctx.db);

    const context = await getGroupContext("-1", ctx.db);
    expect(context?.memberCount).toBe(2);
    expect(context?.content).toContain('group "Family"');
    expect(context?.content).toContain("About this group: Keep it casual");
    expect(context?.content).toContain("George (@drumslave) — also known as: Dad, Boss");
    expect(context?.content).toContain("Alice Smith");
  });

  it("returns null for a group with no members and no notes", async () => {
    await rememberGroupActivity({ chatId: "-1", title: "Empty", type: "group", userId: null }, ctx.db);
    expect(await getGroupContext("-1", ctx.db)).toBeNull();
  });

  it("returns null for an unknown group", async () => {
    expect(await getGroupContext("-404", ctx.db)).toBeNull();
  });
});
