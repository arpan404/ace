import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { AdapterRegistry } from "@ace/daemon";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { ConductorPlan, ConductorSpec } from "@ace/protocol";
import { ConductorClient } from "./index.ts";
import { setup, ready, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

// A required plan gate keeps a valid native Deck idle while its watcher reconnects.
test("Deck watches reacquire a snapshot on reconnect and stop receiving after close", async () => {
  const plan = ConductorPlan.parse({
    summary: "One card, awaiting approval",
    workstreams: [
      {
        id: "note",
        title: "Write a note",
        dependencies: [],
        priority: 0,
        brief: {
          objective: "Write a note",
          instructions: "Write note.md",
          acceptance: ["Note exists"],
          files: ["note.md"],
          packages: [],
          risks: [],
        },
      },
    ],
  });
  const registry = new AdapterRegistry();
  registry.register(
    createTurnProvider({
      provider: "codex",
      reply: JSON.stringify({ kind: "plan", plan }),
      config: ScriptedTurnConfig.parse({}),
      now: () => 1000,
      schedule: () => () => {},
    }),
    { installed: true, auth: "logged_in", loginHint: "scripted fixture" },
  );
  const f = await setup(undefined, undefined, { registry });
  cleanup = f.cleanup;
  const instance = {
    id: "codex-cli-default",
    provider: "codex" as const,
    cwd: f.directory,
    executable: "unused-scripted-cli",
    loginRevision: "scripted",
  };
  f.daemon.models.registerInstance(instance);
  await f.daemon.models.updateFromSession(instance, {
    models: {
      currentModelId: "scripted",
      availableModels: [{ modelId: "scripted", name: "Scripted model" }],
    },
  });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.directory, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Client fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  );
  const { client, faults, scheduler } = f.make();
  const control = f.make().client;
  await ready(client);
  await ready(control);
  const model = { provider: "codex", model: "scripted", tier: "normal", cost: 0, quota: 1 };
  const spec = ConductorSpec.parse({
    rootAgentId: "00000000-0000-4000-8000-000000000083",
    workspaceId: f.workspaceId,
    goal: "Watch the idle Deck",
    repositoryRules: "",
    constraints: {
      providers: ["codex"],
      models: ["scripted"],
      accounts: ["local.codex"],
      budget: 10,
      maxParallel: 1,
      deadline: null,
      stallAfterMs: 60000,
    },
    policies: {
      planApproval: "required",
      merge: "ask",
      maxFixRounds: 1,
      roles: { planner: [model], worker: [model], reviewer: [model], integrator: [model] },
    },
  });
  expect(await control.command({ type: "conductor.start", runId: "watched", spec })).toMatchObject({
    ok: true,
  });
  const decks = new ConductorClient(client, () => "deck-watch");
  const watch = decks.watch("watched");
  try {
    await when(watch.run, (run) => run?.needsUser[0]?.kind === "plan" || !!run?.executionError);
    expect(watch.run.getSnapshot()?.executionError).toBeUndefined();
    const startedAt = watch.run.getSnapshot()?.startedAt;
    faults.disconnect();
    await when(client.connectionState(), (state) => state === "reconnecting");
    expect(await control.command({ type: "conductor.pause", runId: "watched" })).toMatchObject({
      ok: true,
    });
    scheduler.advance(1000);
    await when(watch.run, (run) => run?.phase === "paused");
    expect(watch.run.getSnapshot()?.startedAt).toBe(startedAt);
    expect(watch.error.getSnapshot()).toBeUndefined();
    expect((await decks.list()).runs.some((run) => run.id === "watched")).toBe(true);
    watch.close();
    expect(await control.command({ type: "conductor.cancel", runId: "watched" })).toMatchObject({
      ok: true,
    });
    expect((await decks.get("watched")).phase).toBe("cancelled");
    expect(watch.run.getSnapshot()?.phase).toBe("paused");
  } finally {
    watch.close();
  }
});
