import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command, WorkspaceActionRequest, type ForgeLifecycleAction } from "@ace/protocol";
import { fakeGh, repository } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
export async function setupLifecycle(
  fixtures: import("@ace/forge/testing").Fixtures,
  transform?: (
    request: import("@ace/forge").CommandRequest,
    run: import("@ace/forge").CommandRunner,
  ) => Promise<import("@ace/forge").CommandResult>,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-lifecycle-"));
  const gh = await fakeGh(fixtures);
  const path = join(root, "store.sqlite");
  let store = new Store(path);
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      transform
        ? transform(request, (next) => gh.runner({ ...next, command: gh.executable }))
        : gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  const pr = { repository, number: 7 };
  const read = async () => {
    const result = await runtime.read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "read",
        operation: { op: "forge.pr.lifecycle", workspaceId, repository, number: 7 },
      }),
    );
    if (result.result.kind !== "forge" || result.result.data.resource !== "prLifecycle")
      throw new Error("Missing lifecycle state");
    return result.result.data.value;
  };
  const command = (id: string, action: ForgeLifecycleAction, expectedVersion: string) =>
    Command.parse({
      id,
      deviceId: "device",
      payload: {
        type: "forge.hosted.lifecycle",
        workspaceId,
        pr,
        operation: { kind: "apply", action, expectedVersion },
      },
    });
  return {
    gh,
    command,
    root,
    workspaceId,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    read,
    send(id: string, action: ForgeLifecycleAction, expectedVersion: string) {
      return runtime.execute(command(id, action, expectedVersion));
    },
    reconcile(operationId: string) {
      return runtime.execute(
        Command.parse({
          id: `reconcile-${operationId}`,
          deviceId: "device",
          payload: {
            type: "forge.hosted.lifecycle",
            workspaceId,
            pr,
            operation: { kind: "reconcile", operationId },
          },
        }),
      );
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(path);
      runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    },
    async cleanup() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
