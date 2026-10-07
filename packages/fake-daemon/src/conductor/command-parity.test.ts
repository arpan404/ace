import { expect, test } from "vitest";
import { Command, ConductorSpec } from "@ace/protocol";
import { spec } from "@ace/conductor/test-support";
import { FakeDaemon } from "../index.ts";
import { FakeConductor } from "./fake-conductor.ts";

const nativeSpec = () =>
  ConductorSpec.parse({
    ...spec({ planApproval: "required" }),
    rootAgentId: "93b6f5c9-075a-4b10-a21e-c30c8a404322",
  });

test("the fake refuses an invalid native root before creating a run", () => {
  const conductor = new FakeConductor({ clock: () => 1000, runs: [] });
  expect(
    conductor.command({
      type: "conductor.start",
      runId: "deck",
      spec: ConductorSpec.parse({ ...spec(), rootAgentId: "invalid-root" }),
    }),
  ).toEqual({
    ok: false,
    error: "conductor_invalid_root_agent",
  });
  expect(conductor.runs()).toEqual([]);
});

test("the fake validates internal receipts before applying a decision", () => {
  const conductor = new FakeConductor({ clock: () => 1000, runs: [] });
  expect(conductor.command({ type: "conductor.start", runId: "deck", spec: nativeSpec() })).toEqual(
    { ok: true },
  );
  const before = conductor.runs()[0];
  expect(conductor.command({ type: "conductor.pause", runId: "deck" }, "worker:1")).toEqual({
    ok: false,
    error: "conductor_command_failed",
  });
  expect(conductor.runs()[0]).toEqual(before);
});

test("the fake replays a receipt even after its gate has closed", () => {
  const conductor = new FakeConductor({ clock: () => 1000, runs: [] });
  conductor.command({ type: "conductor.start", runId: "deck", spec: nativeSpec() });
  const gate = conductor.runs()[0]?.gate;
  if (!gate) throw new Error("Plan gate missing");
  const decision = {
    type: "conductor.approve" as const,
    runId: "deck",
    approval: { gateId: gate.id, decision: "approve" as const },
  };
  expect(conductor.command(decision, "cmd.receipt")).toEqual({ ok: true });
  const applied = conductor.runs()[0];
  expect(conductor.command(decision, "cmd.receipt")).toEqual({ ok: true });
  expect(conductor.runs()[0]).toEqual(applied);
  expect(conductor.command(decision, "cmd.new")).toEqual({ ok: false, error: "gate_not_pending" });
});

test("starting an admitted fake run again leaves it intact", () => {
  const conductor = new FakeConductor({ clock: () => 1000, runs: [] });
  const start = { type: "conductor.start" as const, runId: "deck", spec: nativeSpec() };
  conductor.command(start);
  conductor.command({ type: "conductor.pause", runId: "deck" });
  const before = conductor.runs()[0];
  expect(conductor.command(start)).toEqual({ ok: true });
  expect(conductor.runs()[0]).toEqual(before);
});

test.each(["workspace", "git", "provider", "account"] as const)(
  "the fake rejects an unavailable %s using its own host facts",
  (scenario) => {
    const daemon = new FakeDaemon({ clock: () => 1000 });
    const project = daemon.projects.command({
      type: "workspace.create",
      parent: "/fake",
      name: "deck",
      ...(scenario === "git" ? {} : { git: { initialBranch: "main" } }),
    });
    if (!project?.ok || !project.workspace) throw new Error("Project creation failed");
    const model = { provider: "claude", model: "strong", tier: "normal", cost: 1, quota: 1 };
    const base = nativeSpec();
    const config = ConductorSpec.parse({
      ...base,
      workspaceId: scenario === "workspace" ? "missing" : project.workspace.id,
      constraints: {
        ...base.constraints,
        providers: ["claude"],
        models: ["strong"],
        accounts: [scenario === "account" ? "missing" : "claude-personal"],
      },
      policies: {
        ...base.policies,
        roles: { planner: [model], worker: [model], reviewer: [model], integrator: [model] },
      },
    });
    if (scenario === "provider")
      daemon.services.providerStatuses = daemon.services.providerStatuses.map((status) =>
        status.provider === "claude" ? { ...status, installed: false } : status,
      );
    const start = () =>
      daemon.command(
        Command.parse({
          id: "browser:1",
          deviceId: "browser",
          payload: { type: "conductor.start", runId: "deck", spec: config },
        }),
      );
    expect(start()).toMatchObject({
      ok: false,
      error:
        scenario === "workspace"
          ? "conductor_workspace_not_found"
          : scenario === "git"
            ? "conductor_workspace_not_git"
            : scenario === "provider"
              ? "conductor_provider_unavailable"
              : "conductor_account_unavailable",
    });
    expect(start()).toEqual(start());
    expect(
      daemon.command(
        Command.parse({
          id: "browser:2",
          deviceId: "browser",
          payload: { type: "conductor.pause", runId: "deck" },
        }),
      ),
    ).toMatchObject({ ok: false, error: "run_not_found" });
  },
);
