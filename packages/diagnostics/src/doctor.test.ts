import { expect, it } from "vitest";
import {
  createDoctorChecks,
  runDoctor,
  formatDoctor,
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
    chromium: async () => "/bin/chromium",
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
  ["chromium", { chromium: async () => undefined }, "warn", "not found", "Install Chrome/Chromium"],
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
it("a hung probe times out and aborts without gating the other checks", async () => {
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
  expect(value.checks.map((check) => check.status)).toEqual(["fail", "ok"]);
  expect(value.checks[0]?.message).toBe("Check timed out");
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
