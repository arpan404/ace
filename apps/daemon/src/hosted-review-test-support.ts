import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, WorkspaceActionRequest, type ForgeReviewAction } from "@ace/protocol";
import { fakeGh, repository, sha, type Fixtures } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
export const submit: ForgeReviewAction = {
  kind: "submit",
  event: "COMMENT",
  headSha: sha,
  body: "Reviewed",
  draftIds: ["draft"],
};
export async function setupReview(
  fixtures: Fixtures,
  transform?: (
    request: import("@ace/forge").CommandRequest,
    run: import("@ace/forge").CommandRunner,
  ) => ReturnType<import("@ace/forge").CommandRunner>,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-review-recovery-"));
  const path = join(root, "store.sqlite");
  const gh = await fakeGh(fixtures);
  let store = new Store(path);
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      transform
        ? transform(request, (next) => gh.runner({ ...next, command: gh.executable }))
        : gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1, options);
  const command = (id: string, action: ForgeReviewAction = submit) =>
    Command.parse({
      id,
      deviceId: "device",
      payload: { type: "forge.hosted.review", workspaceId, pr: { repository, number: 7 }, action },
    });
  return {
    gh,
    command,
    workspaceId,
    get runtime() {
      return runtime;
    },
    get store() {
      return store;
    },
    send: (id: string, action: ForgeReviewAction = submit) => runtime.execute(command(id, action)),
    async state(repo = repository) {
      const result = await runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "state",
          operation: { op: "forge.pr.review-state", workspaceId, repository: repo, number: 7 },
        }),
      );
      if (result.result.kind !== "forge" || result.result.data.resource !== "prReviewState")
        throw new Error("Missing review state");
      return result.result.data.value;
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(path);
      runtime = new WorkspaceRuntime(store, root, () => 2, options);
    },
    async cleanup() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
