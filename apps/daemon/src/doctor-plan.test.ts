import { expect, it } from "vitest";
import type { DiagnosticReport } from "@ace/protocol";
import { planDoctorRepairs, recommendedRepairs } from "./doctor-plan.ts";

const report = (
  checks: [id: string, status: "ok" | "warn" | "fail", message?: string][],
): DiagnosticReport => ({
  at: 1,
  checks: checks.map(([id, status, message]) => ({ id, status, message: message ?? id, fix: "" })),
});

it("a healthy setup needs no repairs", () => {
  const plan = planDoctorRepairs(
    report([
      ["sqlite", "ok"],
      ["sqlite.space", "ok"],
      ["home.permissions", "ok"],
    ]),
    "running",
  );
  expect(plan).toEqual([]);
});

it("folder problems and reclaimable space are both recommended while ace runs", () => {
  const plan = planDoctorRepairs(
    report([
      ["home.permissions", "warn", "ace data folder: permissions need repair"],
      ["logs.directory", "warn", "Log folder: missing"],
      ["sqlite", "ok"],
      ["sqlite.space", "warn", "SQLite: 900 MiB allocated, 300 MiB reusable"],
    ]),
    "running",
  );
  expect(plan.map((repair) => repair.title)).toEqual([
    "Fix ace folder access",
    "Reclaim database space",
  ]);
  expect(recommendedRepairs(plan)).toEqual(["folders", "database"]);
});

it("reclaiming space waits for ace to run instead of writing an offline database", () => {
  const plan = planDoctorRepairs(
    report([
      ["sqlite", "ok"],
      ["sqlite.wal", "warn", "SQLite WAL: 64 MiB"],
    ]),
    "stopped",
  );
  expect(plan).toHaveLength(1);
  expect(plan[0]?.blocked).toContain("No offline database writes");
  expect(recommendedRepairs(plan)).toEqual([]);
});

it("a database whose integrity isn't confirmed is never compacted, and doctor says why", () => {
  for (const status of ["fail", "warn"] as const) {
    const plan = planDoctorRepairs(
      report([
        ["sqlite", status, "Didn't finish within 5 s"],
        ["sqlite.space", "warn"],
      ]),
      "running",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]?.blocked).toContain("integrity check");
    expect(recommendedRepairs(plan)).toEqual([]);
  }
});
