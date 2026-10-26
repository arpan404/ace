import { describe, expect, it } from "vitest";
import { detectLockedUse } from "./locked-use-detect.ts";
import {
  emptyLayout,
  fakeMac,
  fakeTeam,
  fakeVersion,
  installedLayout,
  permitWith,
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
    const status = await statusOf({ ...installedLayout(), rule: ruleWith([]), permit: null });
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

  it("finds ace's right only inside a plist, not in stray text", async () => {
    const status = await statusOf({
      ...installedLayout(),
      rule: "<string>dev.ace.locked-use.permit</string>",
    });
    expect(status.state).toBe("driftRepairNeeded");
  });

  it("needs repair when the unlock rule names ace's right but that right isn't defined", async () => {
    const status = await statusOf({ ...installedLayout(), permit: null });
    expect(status).toEqual({
      state: "driftRepairNeeded",
      reason: "The screen saver unlock rule names ace's unlock right, which is missing.",
    });
  });

  it("never reports on when ace's mechanism sits under the screen saver right's ignored mechanisms key", async () => {
    const mechanisms =
      "\t<key>mechanisms</key>\n\t<array><string>AceLockedUseAuthorization:permit</string></array>";
    for (const rule of [
      ruleWith([], { extra: mechanisms }),
      ruleWith(["dev.ace.locked-use.permit"], { extra: mechanisms }),
    ]) {
      const status = await statusOf({ ...installedLayout(), rule });
      expect(status).toEqual({
        state: "driftRepairNeeded",
        reason: "The screen saver unlock rule has an ace entry macOS ignores.",
      });
    }
  });

  it("needs repair when the screen saver right naming ace isn't an either-or rule", async () => {
    const status = await statusOf({
      ...installedLayout(),
      rule: ruleWith(["dev.ace.locked-use.permit"], { klass: "evaluate-mechanisms" }),
    });
    expect(status).toEqual({
      state: "driftRepairNeeded",
      reason: "The screen saver unlock rule isn't an either-or rule.",
    });
  });

  it("needs repair when ace's right has the wrong class or doesn't run ace's mechanism", async () => {
    for (const permit of [
      permitWith(undefined, "rule"),
      permitWith(["builtin:authenticate"]),
      permitWith(["AceLockedUseAuthorization:permit-everything"]),
    ]) {
      const status = await statusOf({ ...installedLayout(), permit });
      expect(status).toEqual({
        state: "driftRepairNeeded",
        reason: "ace's unlock right doesn't run ace's plug-in.",
      });
    }
  });

  it("needs repair when ace's right is left behind without the rule naming it, even with the setting off", async () => {
    const status = await statusOf({ ...emptyLayout(), permit: permitWith() }, false);
    expect(status).toEqual({
      state: "driftRepairNeeded",
      reason: "ace's unlock right is defined but the screen saver rule doesn't name it.",
    });
  });

  it("needs repair, never on, when ace's right can't be read", async () => {
    const status = await statusOf({ ...installedLayout(), permit: undefined });
    expect(status).toEqual({
      state: "driftRepairNeeded",
      reason: "Couldn't read ace's unlock right.",
    });
  });
});
