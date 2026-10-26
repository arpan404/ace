import { describe, expect, it } from "vitest";
import { detectLockedUse } from "./locked-use-detect.ts";
import {
  emptyLayout,
  fakeMac,
  fakeTeam,
  fakeVersion,
  installedLayout,
  ruleWith,
  type FakeMacLayout,
} from "./locked-use-fake-mac.ts";

const expectation = { bundleVersion: fakeVersion, team: fakeTeam };

async function statusOf(layout: FakeMacLayout, intent = true, pinned = true) {
  const { host } = fakeMac(layout);
  const team = pinned ? fakeTeam : undefined;
  return (await detectLockedUse(host, { ...expectation, team }, intent)).status;
}

describe("locked use detection", () => {
  it("reports off when nothing is installed and the setting is off", async () => {
    expect(await statusOf(emptyLayout(), false)).toEqual({ state: "off" });
  });

  it("reports needs approval when nothing is installed but the setting is on", async () => {
    expect(await statusOf(emptyLayout(), true)).toEqual({ state: "needsApproval" });
  });

  it("reports on when every component is present, signed by the pinned team and current", async () => {
    expect(await statusOf(installedLayout())).toEqual({ state: "on" });
  });

  it("needs repair when the plug-in is signed by another team", async () => {
    const status = await statusOf({ ...installedLayout(), team: "ZZZZZ99999" });
    expect(status).toMatchObject({ state: "driftRepairNeeded" });
    expect(JSON.stringify(status)).toMatch(/different team/);
  });

  it("never reports on when this build has no pinned team", async () => {
    expect(await statusOf(installedLayout(), true, false)).toMatchObject({
      state: "driftRepairNeeded",
    });
  });

  it("needs repair when the signature doesn't verify", async () => {
    expect(await statusOf({ ...installedLayout(), signatureValid: false })).toMatchObject({
      state: "driftRepairNeeded",
    });
  });

  it("needs repair when the relock guardian isn't loaded", async () => {
    const status = await statusOf({ ...installedLayout(), guardian: false });
    expect(status).toEqual({
      state: "driftRepairNeeded",
      reason: "The relock guardian isn't loaded.",
    });
  });

  it("needs repair when the unlock rule lacks ace's alternative", async () => {
    const status = await statusOf({ ...installedLayout(), rule: ruleWith([]) });
    expect(status).toEqual({
      state: "driftRepairNeeded",
      reason: "The screen saver unlock rule doesn't include ace.",
    });
  });

  it("needs repair when the installed plug-in is a different version", async () => {
    const status = await statusOf({ ...installedLayout(), version: "0" });
    expect(JSON.stringify(status)).toMatch(/driftRepairNeeded.*different version/);
  });

  it("needs repair when only a stray daemon is left behind, even with the setting off", async () => {
    expect(await statusOf({ ...emptyLayout(), broker: true }, false)).toMatchObject({
      state: "driftRepairNeeded",
    });
  });

  it("fails safe, never on, when every tool prints garbage", async () => {
    const status = await statusOf({ ...installedLayout(), garbled: true });
    expect(status.state).toBe("driftRepairNeeded");
  });

  it("stays off with the setting off when only the rule can't be read", async () => {
    expect(await statusOf({ ...emptyLayout(), rule: undefined }, false)).toEqual({ state: "off" });
  });

  it("needs repair with the setting on when the rule can't be read", async () => {
    expect(await statusOf({ ...emptyLayout(), rule: undefined }, true)).toMatchObject({
      state: "driftRepairNeeded",
    });
  });

  it("doesn't mistake a lookalike rule entry for ace's mechanism", async () => {
    const status = await statusOf({
      ...installedLayout(),
      rule: ruleWith(["AceLockedUseAuthorization:permit-everything"]),
    });
    expect(status.state).toBe("driftRepairNeeded");
  });

  it("finds the mechanism only inside a plist, not in stray text", async () => {
    const status = await statusOf({
      ...installedLayout(),
      rule: "<string>AceLockedUseAuthorization:permit</string>",
    });
    expect(status.state).toBe("driftRepairNeeded");
  });
});
