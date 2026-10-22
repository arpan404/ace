import { chromiumAppArmorInstall, chromiumAppArmorProfile } from "@ace/browser/linux-sandbox";
import { expect, test } from "vitest";
import { redactDoctorReport } from "./diagnostics-report.ts";

const home = "/home/sam";
// A Linux desktop session's environment, with a custom ACE_HOME.
const env = {
  HOME: home,
  ACE_HOME: "/srv/ace-sam",
  XDG_SESSION_CLASS: "user",
  XDG_SESSION_TYPE: "wayland",
  XDG_CURRENT_DESKTOP: "GNOME",
};
const apparmorFix = `Install ace's AppArmor profile once:\n${chromiumAppArmorInstall(
  chromiumAppArmorProfile("/srv/ace-sam/chromium/*/chrome-linux{64,-arm64}/chrome"),
)}`;
const raw = {
  at: 1,
  checks: [
    {
      id: "chromium",
      status: "fail" as const,
      message: "ace's browser cannot start its sandbox: AppArmor restricts user namespaces",
      fix: apparmorFix,
    },
    {
      id: "linux.systemd-user",
      status: "ok" as const,
      message: "systemd user session available",
      fix: "Run ace in a systemd user session.",
    },
    {
      id: "disk",
      status: "warn" as const,
      message: `Low disk space in ${home}/.ace`,
      fix: "Free some disk space.",
    },
  ],
};

test("a fix the redaction would break points at ace doctor fix instead of printing garbage", () => {
  const report = redactDoctorReport(raw, env, home);
  const chromium = report.checks.find((check) => check.id === "chromium");
  expect(chromium?.fix).toBe("Run `ace doctor fix chromium` to print the fix for this machine.");
  expect(JSON.stringify(report)).not.toContain("/srv/ace-sam");
});

test("check ids and session words survive redaction; private paths still don't", () => {
  const report = redactDoctorReport(raw, env, home);
  expect(report.checks.map((check) => check.id)).toEqual([
    "chromium",
    "linux.systemd-user",
    "disk",
  ]);
  expect(report.checks[0]?.message).toContain("AppArmor restricts user namespaces");
  expect(report.checks[1]?.message).toBe("systemd user session available");
  expect(report.checks[2]?.message).toMatch(/^Low disk space in <[A-Z]+>\/\.ace$/);
  expect(report.checks[2]?.fix).toBe("Free some disk space.");
});
