import { ProviderStatus } from "@ace/protocol";
import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { machineConnection, machineProviders } from "./mobile-machines.ts";

const now = 10_000_000;
const hour = 3_600_000;
const status = (provider: string, extra: Record<string, unknown>) =>
  ProviderStatus.parse({
    provider,
    runtime: "cli",
    installed: true,
    auth: "logged_in",
    loginHint: "",
    stale: false,
    refreshing: false,
    ...extra,
  });
const account = (provider: string, id: string, windows: Record<string, unknown>) =>
  AccountSummary.parse({
    id,
    provider,
    label: id,
    availability: "available",
    quota: { auth: "logged_in", observedAt: now - 1000, windows, usage: {} },
  });
const session = (usedPercent: number, resetsAt: number) => ({
  primary: { usedPercent, resetsAt, windowDurationMins: 300 },
});

test("a signed-in CLI reads Ready with what is left of its limits; missing CLIs share one line", () => {
  const result = machineProviders(
    [
      status("codex", {
        readiness: "signed_in",
        accountLabel: "arpan@example.com",
        version: "0.9.1",
      }),
      status("claude", { installed: false, readiness: "not_installed", auth: "unknown" }),
    ],
    [account("codex", "codex-main", session(38, now + 2 * hour))],
    now,
  );
  expect(result.absent).toEqual(["Claude Code"]);
  expect(result.providers).toEqual([
    {
      provider: "codex",
      name: "Codex",
      status: { label: "Ready", token: "done" },
      summary: "Signed in as arpan@example.com",
      version: "0.9.1",
      usage: [{ label: "Session (5h)", left: "62% left", resets: "Resets in 2h" }],
    },
  ]);
});

test("a signed-out CLI asks the person to sign in, in the needs-you colour", () => {
  const [row] = machineProviders(
    [status("codex", { readiness: "installed_signed_out", auth: "logged_out" })],
    [],
    now,
  ).providers;
  expect(row?.status).toEqual({ label: "Sign in needed", token: "needsYou" });
});

test("a machine that withholds its accounts still lists its CLIs, with no usage guessed", () => {
  const result = machineProviders([status("claude", { readiness: "signed_in" })], [], now);
  expect(result.providers.map((row) => [row.name, row.status.label, row.usage])).toEqual([
    ["Claude Code", "Ready", []],
  ]);
});

test("a reading whose reset has passed says so instead of showing an old figure as current", () => {
  const [row] = machineProviders(
    [status("codex", { readiness: "signed_in" })],
    [account("codex", "a", session(90, now - hour))],
    now,
  ).providers;
  expect(row?.usage[0]?.resets).toBe("Reset since this reading");
});

test("a CLI that doesn't report its sign-in reads Installed rather than checking forever", () => {
  const [row] = machineProviders(
    [status("pi", { readiness: "signed_in", auth: "unknown" })],
    [],
    now,
  ).providers;
  expect(row?.status).toEqual({ label: "Installed", token: "neutral" });
});

test("a machine's connection reads as one word, and a lost pairing asks to pair again", () => {
  expect(machineConnection("ready")).toEqual({ label: "Connected", token: "done" });
  expect(machineConnection("reconnecting", "unreachable").label).toBe("Can't reach");
  expect(machineConnection("offline", "offline").label).toBe("Offline");
  expect(machineConnection("fatal", "revoked")).toEqual({ label: "Pair again", token: "failed" });
  expect(machineConnection("fatal", "pin").label).toBe("Pair again");
});
