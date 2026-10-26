import type { MacCommandResult, MacHost } from "./locked-use-host.ts";
import { lockedUseBundlePath, lockedUsePermitRight } from "./locked-use-host.ts";

/** A pretend Mac for tests: each field is one component as the real tools would report it. */
export interface FakeMacLayout {
  bundle: boolean;
  signatureValid: boolean;
  team: string;
  identifier: string;
  version: string;
  /** Raw `security authorizationdb read system.login.screensaver` stdout; undefined fails. */
  rule: string | undefined;
  /**
   * Raw `security authorizationdb read dev.ace.locked-use.permit` stdout; null when the right
   * isn't defined (macOS prints `NO (-60005)`), undefined for any other failed read.
   */
  permit: string | null | undefined;
  broker: boolean;
  guardian: boolean;
  /** Replaces every command's output, as a broken tool would. */
  garbled?: boolean;
}

export const fakeTeam = "ABCDE12345";
export const fakeVersion = "1";

function plistOf(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}

const stringArray = (values: readonly string[]) =>
  `<array>\n${values.map((value) => `\t\t<string>${value}</string>`).join("\n")}\n\t</array>`;

/**
 * The screen saver right as macOS ships it (an OR rule), with `names` added to its `rule`
 * alternatives; `extra` is spliced in as more dict entries.
 */
export function ruleWith(
  names: readonly string[],
  options: { klass?: string; extra?: string } = {},
): string {
  return plistOf(`\t<key>class</key>
\t<string>${options.klass ?? "rule"}</string>
\t<key>comment</key>
\t<string>The owner or any administrator can unlock the screensaver.</string>
\t<key>created</key>
\t<real>700000000.5</real>
\t<key>k-of-n</key>
\t<integer>1</integer>
\t<key>rule</key>
\t${stringArray(["authenticate-session-owner-or-admin", ...names])}
\t<key>shared</key>
\t<true/>
${options.extra ?? ""}`);
}

/** ace's permit right as the installer writes it, or with another class or mechanisms. */
export function permitWith(
  mechanisms: readonly string[] = ["AceLockedUseAuthorization:permit"],
  klass = "evaluate-mechanisms",
): string {
  return plistOf(`\t<key>class</key>
\t<string>${klass}</string>
\t<key>mechanisms</key>
\t${stringArray(mechanisms)}
\t<key>shared</key>
\t<false/>`);
}

export function installedLayout(): FakeMacLayout {
  return {
    bundle: true,
    signatureValid: true,
    team: fakeTeam,
    identifier: "dev.ace.locked-use.authorization-plugin",
    version: fakeVersion,
    rule: ruleWith([lockedUsePermitRight]),
    permit: permitWith(),
    broker: true,
    guardian: true,
  };
}

export function emptyLayout(): FakeMacLayout {
  return {
    ...installedLayout(),
    bundle: false,
    rule: ruleWith([]),
    permit: null,
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
      if (command.endsWith("security")) {
        const read = args[2] === lockedUsePermitRight ? layout.permit : layout.rule;
        if (read === null) return Promise.resolve({ code: 1, stdout: "", stderr: "NO (-60005)" });
        return Promise.resolve(
          read === undefined
            ? { code: 1, stdout: "", stderr: "security: read failed" }
            : ok(read, "YES (0)"),
        );
      }
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
