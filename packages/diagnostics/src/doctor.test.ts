import { expect, it } from "vitest";
import {
  createDoctorChecks,
  runDoctor,
  formatDoctor,
  integrityBudgetMs,
  MAX_INTEGRITY_BUDGET_MS,
  type DoctorProbes,
  type CheckResult,
} from "./index.ts";
import { deferred } from "./test-support.ts";
function healthy(): DoctorProbes {
  return {
    node: async () => "v24.1.0",
    provider: async () => ({
      installed: true,
      version: "1.2.3",
      auth: "logged_in",
      loginHint: "cli login",
    }),
    git: async () => "git version 2.49.0",
    pty: async () => true,
    chromium: async () => ({ status: "ok", message: "Chrome starts", fix: "No action needed." }),
    disk: async () => ({ writable: true, freeBytes: 2 * 1024 ** 3 }),
    integrity: async () => "ok",
    port: async () => true,
  };
}
async function report(probes: DoctorProbes) {
  return runDoctor(createDoctorChecks(probes), { now: () => 123 });
}
function result(checks: CheckResult[], id: string) {
  const item = checks.find((check) => check.id === id);
  if (!item) throw new Error("missing result");
  return item;
}
it("healthy probes report machine checks and provider versions/login with actionable hints", async () => {
  const value = await report(healthy());
  expect(value.at).toBe(123);
  for (const check of value.checks) {
    expect(check.status).toBe(check.id === "provider.antigravity" ? "warn" : "ok");
    expect(check.fix.length).toBeGreaterThan(10);
  }
  expect(result(value.checks, "provider.codex").message).toContain("1.2.3, logged_in");
  expect(formatDoctor(value)).toContain("WARN provider.antigravity");
  expect(formatDoctor(value)).toContain("Fix:");
});
const unhealthy: readonly (readonly [
  string,
  Partial<DoctorProbes>,
  "warn" | "fail",
  string,
  string,
])[] = [
  ["node", { node: async () => "v23.9.0" }, "fail", "Node v23.9.0", "Node 24"],
  ["node", { node: async () => "not a version" }, "fail", "not a version", "Node 24"],
  ["git", { git: async () => undefined }, "fail", "git not found", "Install git"],
  ["node-pty", { pty: async () => false }, "fail", "cannot load", "Reinstall/rebuild node-pty"],
  [
    "disk",
    { disk: async () => ({ writable: false, freeBytes: 2 * 1024 ** 3 }) },
    "fail",
    "not readable and writable",
    "permissions",
  ],
  [
    "disk",
    { disk: async () => ({ writable: true, freeBytes: 1024 }) },
    "fail",
    "0 MiB free",
    "Free disk space",
  ],
  [
    "disk",
    { disk: async () => ({ writable: true, freeBytes: 128 * 1024 ** 2 }) },
    "warn",
    "128 MiB free",
    "Free disk space",
  ],
  ["sqlite", { integrity: async () => "corrupt" as const }, "fail", "corrupt", "known-good backup"],
  [
    "sqlite",
    { integrity: async () => "missing" as const },
    "warn",
    "missing",
    "initialize a new database",
  ],
  [
    "sqlite",
    { integrity: async () => "unavailable" as const },
    "fail",
    "could not be read",
    "lock contention",
  ],
  ["port", { port: async () => false }, "warn", "already in use", "unused port"],
];
it.each(unhealthy)(
  "%s explains an unhealthy machine probe",
  async (id, change, status, message, fix) => {
    const check = result((await report({ ...healthy(), ...change })).checks, id);
    expect(check.status).toBe(status);
    expect(check.message).toContain(message);
    expect(check.fix).toContain(fix);
    expect(check.message.length).toBeGreaterThan(5);
    expect(check.fix.length).toBeGreaterThan(10);
    expect(formatDoctor({ at: 0, checks: [check] })).toContain(check.message);
    if (id === "disk") {
      expect(check.fix).toContain("ACE_HOME");
      if (check.message.includes("MiB")) expect(check.fix).toContain("Free disk space");
    }
  },
);
it.each(["claude", "codex", "opencode", "cursor"] as const)(
  "%s distinguishes absent, logged-out and unknown CLI status",
  async (id) => {
    for (const [installed, auth, expected] of [
      [false, "unknown", "warn"],
      [true, "logged_out", "fail"],
      [true, "unknown", "warn"],
    ] as const) {
      const value = await report({
        ...healthy(),
        provider: async () => ({ installed, auth, version: "1.0.0", loginHint: "cli login" }),
      });
      const check = result(value.checks, `provider.${id}`);
      expect(check.status).toBe(expected);
      expect(check.fix).toContain(installed ? "cli login" : "Install");
    }
  },
);
it("a hung probe is reported as unfinished, not failed, and aborts without gating the other checks", async () => {
  const begun = deferred<void>(),
    other = deferred<void>();
  const timeouts: (() => void)[] = [];
  let signal: AbortSignal | undefined;
  const pending = runDoctor(
    [
      {
        id: "hung",
        fix: "Repair probe",
        run: async (value) => {
          signal = value;
          begun.resolve();
          return new Promise(() => {});
        },
      },
      {
        id: "healthy",
        fix: "None",
        run: async () => {
          other.resolve();
          return { status: "ok", message: "done", fix: "None" };
        },
      },
    ],
    {
      now: () => 0,
      schedule: (callback) => {
        timeouts.push(callback);
        return () => {};
      },
    },
  );
  await Promise.all([begun.promise, other.promise]);
  timeouts[0]?.();
  const value = await pending;
  expect(signal?.aborted).toBe(true);
  expect(value.checks.map((check) => check.status)).toEqual(["warn", "ok"]);
  expect(value.checks[0]?.message).toBe("Didn't finish within 5 s");
  expect(value.checks[0]?.fix).toContain("Repair probe");
});
it("a failing probe cannot leak its exception or stop other checks", async () => {
  const value = await report({
    ...healthy(),
    pty: async () => {
      throw new Error("token=private");
    },
  });
  expect(result(value.checks, "node-pty").status).toBe("fail");
  expect(result(value.checks, "git").status).toBe("ok");
  expect(JSON.stringify(value)).not.toContain("private");
});

it("the integrity check gets time in proportion to the database, with room for slow disks, and a hard cap", () => {
  const gib = 1024 ** 3;
  // Measured: a full integrity check reads about 1 GiB per 1.7 s on a warm SSD.
  const measured = (bytes: number) => (bytes / gib) * 1_700;
  expect(integrityBudgetMs(0)).toBe(30_000);
  for (const size of [1, 6, 20, 40].map((n) => n * gib))
    expect(integrityBudgetMs(size)).toBeGreaterThanOrEqual(measured(size) * 10);
  expect(integrityBudgetMs(6 * gib)).toBeGreaterThan(integrityBudgetMs(1 * gib));
  expect(integrityBudgetMs(10_000 * gib)).toBe(MAX_INTEGRITY_BUDGET_MS);
});

it("a check with its own budget keeps running after the default limit cuts off a hung one", async () => {
  const slow = deferred<void>();
  const timers: { ms: number; fire: () => void }[] = [];
  const pending = runDoctor(
    [
      {
        id: "sqlite",
        fix: "Restore a backup",
        timeoutMs: 120_000,
        run: async () => {
          await slow.promise;
          return { status: "ok", message: "SQLite integrity: ok", fix: "" };
        },
      },
      { id: "hung", fix: "Repair probe", run: () => new Promise(() => {}) },
    ],
    {
      now: () => 0,
      schedule: (fire, ms) => {
        timers.push({ ms, fire });
        return () => {};
      },
    },
  );
  await Promise.resolve();
  // Five seconds pass: only timers at or under the default limit fire.
  for (const timer of timers) if (timer.ms <= 5_000) timer.fire();
  slow.resolve();
  const value = await pending;
  expect(value.checks.map((check) => [check.id, check.status])).toEqual([
    ["sqlite", "ok"],
    ["hung", "warn"],
  ]);
});
