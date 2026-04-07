import { basename } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
} from "@ace/contracts";
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import {
  addCliProject,
  CliProjectServicesLive,
  listCliProjects,
  removeCliProject,
} from "./cliProjects";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";

async function createCliProjectSystem() {
  const runtime = ManagedRuntime.make(
    CliProjectServicesLive.pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "ace-cli-projects-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  return {
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      runtime.runPromise(effect as Effect.Effect<A, E, never>),
    dispose: () => runtime.dispose(),
  };
}

describe("cliProjects", () => {
  it("adds projects idempotently and lists active projects", async () => {
    const system = await createCliProjectSystem();
    const workspaceRoot = await system.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectoryScoped({ prefix: "ace-cli-project-workspace-" });
      }),
    );

    const added = await system.run(addCliProject({ workspaceRoot }));
    expect(added.status).toBe("created");
    expect(added.project.workspaceRoot).toBe(workspaceRoot);
    expect(added.project.title).toBe(basename(workspaceRoot));
    expect(added.project.activeThreadCount).toBe(0);

    const existing = await system.run(addCliProject({ workspaceRoot }));
    expect(existing.status).toBe("existing");
    expect(existing.project.id).toBe(added.project.id);

    const projects = await system.run(listCliProjects);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: added.project.id,
      workspaceRoot,
      activeThreadCount: 0,
    });

    await system.dispose();
  });

  it("removes projects by workspace path", async () => {
    const system = await createCliProjectSystem();
    const workspaceRoot = await system.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectoryScoped({ prefix: "ace-cli-project-remove-" });
      }),
    );

    const added = await system.run(addCliProject({ workspaceRoot }));
    const removed = await system.run(
      removeCliProject({
        selector: workspaceRoot,
        force: false,
      }),
    );

    expect(removed.project.id).toBe(added.project.id);
    expect(removed.deletedThreadCount).toBe(0);
    expect(await system.run(listCliProjects)).toHaveLength(0);

    await system.dispose();
  });

  it("requires --force to remove projects with active threads", async () => {
    const system = await createCliProjectSystem();
    const workspaceRoot = await system.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectoryScoped({ prefix: "ace-cli-project-force-" });
      }),
    );

    const added = await system.run(addCliProject({ workspaceRoot }));
    await system.run(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-cli-project-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-cli-project-force"),
          projectId: added.project.id,
          title: "Workspace thread",
          modelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        });
      }),
    );

    await expect(
      system.run(
        removeCliProject({
          selector: added.project.id,
          force: false,
        }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Re-run with --force"),
    });

    const removed = await system.run(
      removeCliProject({
        selector: added.project.id,
        force: true,
      }),
    );
    expect(removed.deletedThreadCount).toBe(1);
    expect(await system.run(listCliProjects)).toHaveLength(0);

    await system.dispose();
  });
});
