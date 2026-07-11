import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";
import { getKnownUser, upsertKnownUser } from "./repository";
import { listUsers, rememberUser, updateAliases } from "./service";

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

describe("rememberUser", () => {
  it("captures a user on first message and refreshes the profile without touching aliases", async () => {
    await rememberUser(
      { userId: "1", username: "ann", firstName: "Ann", lastName: null },
      ctx.db,
    );
    await updateAliases("1", { aliases: ["Boss"] }, trigger, ctx.db);

    // A later message with a changed username refreshes the profile but keeps aliases.
    await rememberUser(
      { userId: "1", username: "ann_new", firstName: "Ann", lastName: "Lee" },
      ctx.db,
    );

    const user = await getKnownUser(ctx.db, "1");
    expect(user).toMatchObject({
      userId: "1",
      username: "ann_new",
      firstName: "Ann",
      lastName: "Lee",
      aliases: ["Boss"],
    });
  });
});

describe("listUsers", () => {
  it("returns users most-recently-seen first", async () => {
    await upsertKnownUser(ctx.db, { userId: "1", username: "first", firstName: null, lastName: null });
    await upsertKnownUser(ctx.db, { userId: "2", username: "second", firstName: null, lastName: null });

    const users = await listUsers(ctx.db);
    expect(users.map((u) => u.userId)).toEqual(["2", "1"]);
  });
});

describe("updateAliases", () => {
  it("replaces the alias list and records a trace", async () => {
    await upsertKnownUser(ctx.db, { userId: "1", username: "ann", firstName: "Ann", lastName: null });

    const updated = await updateAliases("1", { aliases: ["Boss", "Chief"] }, trigger, ctx.db);
    expect(updated.aliases).toEqual(["Boss", "Chief"]);

    const { traces } = await listTraces(ctx.db, { feature: "known-users" });
    expect(traces).toHaveLength(1);
    expect(traces[0].action).toBe("update-aliases");
    expect(traces[0].status).toBe("success");
  });

  it("fails for an unknown user and records an error trace", async () => {
    await expect(updateAliases("404", { aliases: [] }, trigger, ctx.db)).rejects.toThrow(
      /unknown user/i,
    );
    const { traces } = await listTraces(ctx.db, { feature: "known-users" });
    expect(traces[0].status).toBe("error");
  });
});
