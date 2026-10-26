import { appArmorRepairHint } from "@ace/browser/engine-check";
import { expect, test } from "vitest";
import { redactDoctorReport } from "./diagnostics-report.ts";

const home = "/home/sam";
// A Linux desktop session's environment, with a custom ACE_HOME and one secret.
const env = {
  HOME: home,
  ACE_HOME: "/srv/ace-sam",
  XDG_SESSION_CLASS: "user",
  XDG_SESSION_TYPE: "wayland",
  XDG_CURRENT_DESKTOP: "GNOME",
  GITHUB_TOKEN: "ghp_doctorRedactionSecret1234567890",
};
const raw = {
  at: 1,
  checks: [
    {
      id: "chromium",
      status: "fail" as const,
      message: "ace's browser cannot start its sandbox: AppArmor restricts user namespaces",
      fix: appArmorRepairHint,
    },
    {
      id: "linux.systemd-user",
      status: "ok" as const,
      message: "systemd user session available (user, wayland, GNOME)",
      fix: "Run ace in a systemd user session.",
    },
    {
      id: "disk",
      status: "warn" as const,
      message: `Low disk space in ${home}/.ace; token ghp_doctorRedactionSecret1234567890`,
      fix: "Free some disk space.",
    },
  ],
};

test("the shared report keeps check ids, session words and the repair hint as written", () => {
  const report = redactDoctorReport(raw, env, home);
  expect(report.checks.map((check) => check.id)).toEqual([
    "chromium",
    "linux.systemd-user",
    "disk",
  ]);
  expect(report.checks[0]?.fix).toBe(appArmorRepairHint);
  expect(report.checks[1]?.message).toBe("systemd user session available (user, wayland, GNOME)");
  expect(report.checks[2]?.fix).toBe("Free some disk space.");
});

test("the shared report hides the home folder and secret values", () => {
  const text = JSON.stringify(redactDoctorReport(raw, env, home));
  expect(text).not.toContain(home);
  expect(text).not.toContain("ghp_doctorRedactionSecret1234567890");
});
