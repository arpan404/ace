import type { MacCommandResult, MacHost } from "./locked-use-host.ts";
import { lockedUseBundlePath } from "./locked-use-host.ts";

/** A pretend Mac for tests: each field is one component as the real tools would report it. */
export interface FakeMacLayout {
  bundle: boolean;
  signatureValid: boolean;
  team: string;
  identifier: string;
  version: string;
  /** Raw `security authorizationdb read` stdout, or undefined for a failed read. */
  rule: string | undefined;
  broker: boolean;
  guardian: boolean;
  /** Replaces every command's output, as a broken tool would. */
  garbled?: boolean;
}

export const fakeTeam = "ABCDE12345";
export const fakeVersion = "1";

export function ruleWith(mechanisms: readonly string[]): string {
  const strings = mechanisms.map((value) => `\t\t<string>${value}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>class</key>
\t<string>rule</string>
\t<key>rule</key>
\t<array>
\t\t<string>authenticate-session-owner-or-admin</string>
${strings}
\t</array>
</dict>
</plist>
`;
}

export function installedLayout(): FakeMacLayout {
  return {
    bundle: true,
    signatureValid: true,
    team: fakeTeam,
    identifier: "dev.ace.locked-use.authorization-plugin",
    version: fakeVersion,
    rule: ruleWith(["AceLockedUseAuthorization:permit"]),
    broker: true,
    guardian: true,
  };
}

export function emptyLayout(): FakeMacLayout {
  return {
    ...installedLayout(),
    bundle: false,
    rule: ruleWith([]),
    broker: false,
    guardian: false,
  };
}

const ok = (stdout: string, stderr = ""): MacCommandResult => ({ code: 0, stdout, stderr });

/** A MacHost backed by a mutable layout; `commands` records every invocation. */
export function fakeMac(layout: FakeMacLayout, clock = { now: 0 }) {
  const commands: string[] = [];
  const host: MacHost = {
    fileExists: (path) => Promise.resolve(path === lockedUseBundlePath && layout.bundle),
    readText(path) {
      if (!layout.bundle || path !== `${lockedUseBundlePath}/Contents/Info.plist`)
        return Promise.reject(new Error("ENOENT"));
      if (layout.garbled) return Promise.resolve("\u0000garbage");
      return Promise.resolve(
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>${layout.version}</string></dict></plist>`,
      );
    },
    exec(command, args) {
      commands.push([command, ...args].join(" "));
      if (layout.garbled) return Promise.resolve({ code: 0, stdout: "%%garbled%%", stderr: "??" });
      const [first, second] = args;
      if (command.endsWith("codesign") && first === "--verify")
        return Promise.resolve(
          layout.signatureValid ? ok("") : { code: 1, stdout: "", stderr: "invalid signature" },
        );
      if (command.endsWith("codesign"))
        return Promise.resolve(
          ok("", `Executable=x\nIdentifier=${layout.identifier}\nTeamIdentifier=${layout.team}\n`),
        );
      if (command.endsWith("security"))
        return Promise.resolve(
          layout.rule === undefined
            ? { code: 1, stdout: "", stderr: "NO (-60005)" }
            : ok(layout.rule, "YES (0)"),
        );
      if (command.endsWith("launchctl")) {
        const label = (second ?? "").replace("system/", "");
        const loaded = label.endsWith("guardian") ? layout.guardian : layout.broker;
        return Promise.resolve(
          loaded
            ? ok(`system/${label} = {\n\tstate = running\n}`)
            : { code: 113, stdout: "", stderr: "Could not find service" },
        );
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected" });
    },
    now: () => clock.now,
  };
  return { host, commands, clock };
}
