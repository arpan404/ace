import { describe, expect, it } from "vitest";
import { blockedReason } from "./policy.ts";

describe.runIf(process.platform === "win32")("Windows block list", () => {
  it("Windows hosts refuse shells, launchers and password managers by exe or Store id", () => {
    for (const bundleId of [
      "cmd.exe",
      "explorer.exe",
      "taskmgr.exe",
      "8bitSolutionsLLC.bitwardendesktop_h4e712dmw3xyy!bitwardendesktop",
      "AgileBits.1Password_amwd9z03whsfe!App",
      "KeePassXC.exe",
    ])
      expect(blockedReason({ bundleId }, [], "win32"), bundleId).toContain(
        "Computer use does not operate this app",
      );
    expect(
      blockedReason({ bundleId: "notepad.exe", name: "Notepad" }, [], "win32"),
    ).toBeUndefined();
  });

  it("Windows identities are not refused for other hosts, where they mean other programs", () => {
    expect(blockedReason({ bundleId: "cmd.exe" }, [], "linux")).toBeUndefined();
    expect(blockedReason({ bundleId: "putty.exe" })).toBeUndefined();
  });
});
