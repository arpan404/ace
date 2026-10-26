import { describe, expect, test } from "vitest";
import {
  type AdminAuthorization,
  appleScriptString,
  buildInstallScript,
  buildRemoveScript,
  privilegedRunner,
  privilegedRunnerFromEnv,
  shellQuote,
} from "./locked-use-privileged.ts";

const artifacts = {
  pluginBundle: "/opt/ace/AceLockedUseAuthorization.bundle",
  brokerExecutable: "/opt/ace/ace-locked-use-authority",
  guardianExecutable: "/opt/ace/ace-locked-use-guardian",
};

function recordingAdmin(): { runs: { purpose: string; script: string }[] } & AdminAuthorization {
  const runs: { purpose: string; script: string }[] = [];
  return {
    runs,
    run(purpose, script) {
      runs.push({ purpose, script });
      return Promise.resolve();
    },
  };
}

describe("locked use privileged install", () => {
  test("install adds our mechanism additively, never replacing Apple's", () => {
    const script = buildInstallScript(artifacts);
    // It reads the existing right and appends our mechanism only if absent; it never clears
    // the mechanisms list, so Apple's and any other provider's mechanisms survive.
    expect(script).toContain("authorizationdb read 'system.login.screensaver'");
    expect(script).toContain("if mechanism not in mechanisms: mechanisms.append(mechanism)");
    expect(script).toContain("authorizationdb write 'system.login.screensaver'");
    expect(script).not.toContain("mechanisms'] = []");
  });

  test("install places the signed bundle at the detector's path and loads both daemons", () => {
    const script = buildInstallScript(artifacts);
    expect(script).toContain(
      "/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle",
    );
    expect(script).toContain(
      "launchctl bootstrap system '/Library/LaunchDaemons/dev.ace.locked-use.authorization.plist'",
    );
    expect(script).toContain(
      "launchctl bootstrap system '/Library/LaunchDaemons/dev.ace.locked-use.guardian.plist'",
    );
    // set -e so a half-finished install cannot look successful.
    expect(script.startsWith("set -e")).toBe(true);
  });

  test("remove reverses only our additions and tolerates partial state", () => {
    const script = buildRemoveScript();
    expect(script).toContain("launchctl bootout system/dev.ace.locked-use.authorization");
    expect(script).toContain("launchctl bootout system/dev.ace.locked-use.guardian");
    expect(script).toContain("m for m in right.get('mechanisms', []) if m != mechanism");
    expect(script).toContain(
      "rm -rf '/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle'",
    );
    // Missing pieces must not fail removal.
    expect(script).toContain("|| exit 0");
  });

  test("a path with a quote cannot break out of its shell argument", () => {
    expect(shellQuote("/opt/a'b")).toBe(`'/opt/a'\\''b'`);
    const script = buildInstallScript({ ...artifacts, pluginBundle: "/opt/a'; rm -rf /" });
    // The injected text stays inside one quoted argument; no bare `rm -rf /` command appears.
    expect(script).not.toMatch(/\n\s*rm -rf \/\s*$/m);
  });

  test("runner refuses a non-absolute artifact path (fails closed)", async () => {
    const admin = recordingAdmin();
    const runner = privilegedRunner({ ...artifacts, brokerExecutable: "relative/path" }, admin);
    await expect(runner.install()).rejects.toThrow();
    expect(admin.runs).toHaveLength(0);
  });

  test("runner runs install then remove through one admin authorization each", async () => {
    const admin = recordingAdmin();
    const runner = privilegedRunner(artifacts, admin);
    await runner.install();
    await runner.remove();
    expect(admin.runs.map((r) => r.purpose)).toEqual([
      "install locked computer use",
      "remove locked computer use",
    ]);
  });

  test("no runner unless every artifact path is staged in the environment", () => {
    expect(privilegedRunnerFromEnv({})).toBeUndefined();
    expect(
      privilegedRunnerFromEnv({
        ACE_LOCKED_USE_PLUGIN: artifacts.pluginBundle,
        ACE_LOCKED_USE_BROKER: artifacts.brokerExecutable,
        // guardian missing
      }),
    ).toBeUndefined();
    expect(
      privilegedRunnerFromEnv({
        ACE_LOCKED_USE_PLUGIN: artifacts.pluginBundle,
        ACE_LOCKED_USE_BROKER: artifacts.brokerExecutable,
        ACE_LOCKED_USE_GUARDIAN: artifacts.guardianExecutable,
      }),
    ).toBeDefined();
  });

  test("admin script is wrapped as an AppleScript literal with escaping", () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});
