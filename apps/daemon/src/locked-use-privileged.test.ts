import { describe, expect, test } from "vitest";
import {
  type AdminAuthorization,
  appleScriptString,
  buildInstallScript,
  buildRemoveScript,
  daemonPlist,
  permitRightPlist,
  privilegedRunner,
  privilegedRunnerFromEnv,
  shellQuote,
} from "./locked-use-privileged.ts";

const artifacts = {
  pluginBundle: "/opt/ace/AceLockedUseAuthorization.bundle",
  brokerExecutable: "/opt/ace/ace-locked-use-authority",
  guardianExecutable: "/opt/ace/ace-locked-use-guardian",
  team: "ABCDE12345",
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
  test("adds ace as a NAMED alternative of the rule, never a mechanisms append", () => {
    const script = buildInstallScript(artifacts);
    // A dedicated evaluate-mechanisms right carries our mechanism; its NAME goes in the
    // screensaver right's `rule` list. The screensaver right's `mechanisms` key is never written.
    expect(permitRightPlist()).toContain("<string>evaluate-mechanisms</string>");
    expect(permitRightPlist()).toContain("AceLockedUseAuthorization:permit");
    expect(script).toContain("authorizationdb write 'dev.ace.locked-use.permit'");
    expect(script).toContain("if name not in rule: rule.append(name)");
    expect(script).toContain("authorizationdb write 'system.login.screensaver'");
    // It must not touch the screensaver right's mechanisms, and must not run our mechanism there.
    expect(script).not.toMatch(/screensaver[\s\S]*mechanisms'\]\.append/);
  });

  test("edits only an OR rule (explicit k-of-n 1, or stock single-rule) and never an AND", () => {
    const script = buildInstallScript(artifacts);
    // Accept k-of-n 1, or a lone sub-rule with no k-of-n (authd reads that as OR); refuse a
    // missing k-of-n with several sub-rules (AND), which would make password unlock need our plug-in.
    expect(script).toContain("not (kofn == 1 or (kofn is None and len(rule) <= 1))");
    expect(script).toContain("sys.exit(3)");
    // Make the OR explicit in the written-back right once it may hold more than one alternative.
    expect(script).toContain("right['k-of-n'] = 1");
  });

  test("stages each component to a root-owned path and verifies its signature before use", () => {
    const script = buildInstallScript(artifacts);
    expect(script).toContain(
      "/Library/Application Support/dev.ace.locked-use/ace-locked-use-authority",
    );
    expect(script).toContain(
      "/Library/Application Support/dev.ace.locked-use/ace-locked-use-guardian",
    );
    expect(script).toContain("chown -R root:wheel");
    // codesign -R pins Apple + our team + each identifier; the daemons run the root-owned copies.
    expect(script).toContain("codesign --verify --strict -R");
    expect(script).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
    expect(script).toContain('identifier "dev.ace.locked-use.authority"');
    // Verify at a staging path next to the destination, then mv into place — an unverified copy
    // is never left where a daemon or the rule would load it; a symlinked source/copy is refused.
    expect(script).toContain(".staging");
    expect(script).toMatch(/codesign --verify[\s\S]*?mv -f/);
    expect(script).toContain("test ! -L");
    const plist = daemonPlist(
      "dev.ace.locked-use.authorization",
      "/Library/Application Support/dev.ace.locked-use/ace-locked-use-authority",
    );
    expect(plist).toContain(
      "/Library/Application Support/dev.ace.locked-use/ace-locked-use-authority",
    );
  });

  test("uses a fresh root-owned temp dir, not fixed /tmp paths a same-user process can plant", () => {
    for (const script of [buildInstallScript(artifacts), buildRemoveScript()]) {
      expect(script).toContain("umask 077");
      expect(script).toContain('work="$(mktemp -d /tmp/ace-locked-use.XXXXXX)"');
      // Root never redirects into a fixed, predictable /tmp filename.
      expect(script).not.toMatch(/> \/tmp\/ace-screensaver-right/);
    }
  });

  test("the rule edit reads the plist from a file argument, not stdin", () => {
    for (const script of [buildInstallScript(artifacts), buildRemoveScript()]) {
      expect(script).toContain("with open(sys.argv[2], 'rb') as handle:");
      expect(script).not.toContain("sys.stdin.buffer.read()");
    }
  });

  test("remove reverses cleanly: daemons out, our rule name gone, permit right deleted, copies removed", () => {
    const script = buildRemoveScript();
    expect(script).toContain("launchctl bootout system/dev.ace.locked-use.authorization");
    expect(script).toContain("launchctl bootout system/dev.ace.locked-use.guardian");
    expect(script).toContain("right['rule'] = [r for r in rule if r != name]");
    expect(script).toContain("authorizationdb remove 'dev.ace.locked-use.permit'");
    expect(script).toContain(
      "/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle",
    );
    // A missing screensaver right skips only the rule edit (if/fi), not the rest of removal.
    expect(script).toContain("if security authorizationdb read 'system.login.screensaver'");
    expect(script).toMatch(/authorizationdb remove 'dev\.ace\.locked-use\.permit'/);
  });

  test("a path with a quote cannot break out of its shell argument", () => {
    expect(shellQuote("/opt/a'b")).toBe(`'/opt/a'\\''b'`);
    const script = buildInstallScript({ ...artifacts, pluginBundle: "/opt/a'; rm -rf /" });
    expect(script).not.toMatch(/\n\s*rm -rf \/\s*$/m);
  });

  test("runner refuses a non-absolute artifact path or a malformed team (fails closed)", async () => {
    const admin = recordingAdmin();
    await expect(
      privilegedRunner({ ...artifacts, brokerExecutable: "relative" }, admin).install(),
    ).rejects.toThrow();
    await expect(
      privilegedRunner({ ...artifacts, team: "bad" }, admin).install(),
    ).rejects.toThrow();
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

  test("no runner unless every artifact path and the team are staged", () => {
    expect(privilegedRunnerFromEnv({})).toBeUndefined();
    expect(
      privilegedRunnerFromEnv({
        ACE_LOCKED_USE_PLUGIN: artifacts.pluginBundle,
        ACE_LOCKED_USE_BROKER: artifacts.brokerExecutable,
        ACE_LOCKED_USE_GUARDIAN: artifacts.guardianExecutable,
        // team missing
      }),
    ).toBeUndefined();
    expect(
      privilegedRunnerFromEnv({
        ACE_LOCKED_USE_PLUGIN: artifacts.pluginBundle,
        ACE_LOCKED_USE_BROKER: artifacts.brokerExecutable,
        ACE_LOCKED_USE_GUARDIAN: artifacts.guardianExecutable,
        ACE_LOCKED_USE_TEAM: artifacts.team,
      }),
    ).toBeDefined();
  });

  test("admin script is wrapped as an AppleScript literal with escaping", () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});
