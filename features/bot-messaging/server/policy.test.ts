import { describe, expect, it } from "vitest";

import { checkMaintenance, isOwner, type BotPolicy } from "./policy";

const OWNER: BotPolicy = { ownerUserId: "42", maintenanceModeEnabled: true };

describe("isOwner", () => {
  it("matches the configured owner by numeric id", () => {
    expect(isOwner({ fromId: 42 }, OWNER)).toBe(true);
    expect(isOwner({ fromId: 43 }, OWNER)).toBe(false);
  });

  it("is false when no owner is configured", () => {
    const policy: BotPolicy = { ownerUserId: null, maintenanceModeEnabled: true };
    expect(isOwner({ fromId: 1 }, policy)).toBe(false);
  });

  it("is false when the sender has no id", () => {
    expect(isOwner({}, OWNER)).toBe(false);
  });
});

describe("checkMaintenance", () => {
  it("never blocks when maintenance is off", () => {
    const policy: BotPolicy = { ...OWNER, maintenanceModeEnabled: false };
    expect(checkMaintenance({ policy, owner: false })).toEqual({ blocked: false });
  });

  it("blocks non-owners when maintenance is on", () => {
    expect(checkMaintenance({ policy: OWNER, owner: false })).toEqual({
      blocked: true,
      reason: "not_owner",
    });
  });

  it("lets the owner through with no extra restriction (fully functional)", () => {
    expect(checkMaintenance({ policy: OWNER, owner: true })).toEqual({ blocked: false });
  });
});
