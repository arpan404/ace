import { describe, expect, it } from "vitest";
import { macHost } from "./locked-use-host.ts";

describe("the real macOS host", () => {
  const host = macHost();
  it.each([
    ["/usr/bin/security", ["authorizationdb", "write", "system.login.screensaver"]],
    ["/usr/bin/security", ["authorizationdb", "remove", "system.login.screensaver"]],
    ["/bin/launchctl", ["bootstrap", "system", "/Library/LaunchDaemons/x.plist"]],
    ["/bin/launchctl", ["bootout", "system/dev.ace.locked-use.guardian"]],
    ["/bin/launchctl", ["print", "system/x; rm -rf /"]],
    ["/usr/bin/codesign", ["--sign", "-", "/tmp/x"]],
    ["/bin/cp", ["/tmp/x", "/Library/Security/SecurityAgentPlugins/"]],
  ])("refuses to run %s %j before starting a process", async (command, args) => {
    await expect(host.exec(command, args)).rejects.toThrow(/Refused/);
  });
});
