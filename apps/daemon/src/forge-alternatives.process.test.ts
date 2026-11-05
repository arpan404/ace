import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { SourceControl } from "./source-control.ts";
import { WorkspaceActionRequest, ForgeRepository } from "@ace/protocol";
import type { CommandRunner } from "@ace/forge";

const head = "a".repeat(40),
  base = "b".repeat(40);
const pr = {
  number: "7",
  state: "open",
  merged: false,
  draft: false,
  title: "Origin change",
  body: "Review description",
  head: { ref: "feature", sha: head },
  base: { ref: "main", sha: base },
  author: { user: { id: "u1", email: "person@example.com" } },
  createdAt: "2026-11-04T12:00:00Z",
  updatedAt: "2026-11-04T12:00:00Z",
  version: { headSha: head, baseSha: base },
};

test("Origin pull request browsing uses its CLI, preserves its identity and blocks GitHub mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-origin-browser-"));
  const settings = new SettingsService({ dataDir: root });
  const store = new Store(join(root, "store.sqlite"));
  let signedIn = "person@example.com";
  let switchAfterApi = false;
  const runner: CommandRunner = async (request) => {
    if (request.command !== "origin") throw new Error("Origin must never call gh");
    const args = request.args;
    if (args[0] === "auth" && args[1] === "status")
      return {
        code: 0,
        stdout: JSON.stringify({ account: signedIn }),
        truncated: false,
      };
    if (args[0] !== "api" || args.at(-1) !== "GET") throw new Error("Unexpected mutation");
    const endpoint = args[1] ?? "";
    const value = endpoint.includes("/files?")
      ? {
          files: [
            {
              filename: "a.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+export const a = 1;",
            },
          ],
          nextPageToken: "",
        }
      : endpoint.includes("/pulls?")
        ? { pullRequests: [pr], nextPageToken: "" }
        : pr;
    if (switchAfterApi) signedIn = "changed@example.com";
    return { code: 0, stdout: JSON.stringify(value), truncated: false };
  };
  const source = new SourceControl(settings, () => runner, root);
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    sourceControl: source,
    forgeRunner: () => runner,
  });
  try {
    await settings.set(
      "sourceControl.preferences",
      {
        hosts: [{ host: "origin.cursor.com", forge: "origin", account: "person@example.com" }],
        host: "origin.cursor.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    const workspaceId = store.createWorkspace(root, "Origin project");
    const repository = ForgeRepository.parse({
      forge: "origin",
      host: "origin.cursor.com",
      owner: "team",
      name: "repo",
    });
    const read = async (operation: object) =>
      runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "read",
          operation: { workspaceId, repository, ...operation },
        }),
      );
    const list = await read({ op: "forge.pr.list", query: {} });
    expect(list.result).toMatchObject({
      kind: "forge",
      data: {
        resource: "prList",
        value: {
          items: [{ title: "Origin change", ref: { repository: { forge: "origin" }, number: 7 } }],
        },
      },
    });
    expect((await read({ op: "forge.pr.detail", number: 7 })).result).toMatchObject({
      kind: "forge",
      data: { resource: "prDetail", value: { readOnly: true, body: "Review description" } },
    });
    expect(
      (await read({ op: "forge.pr.files", number: 7, page: 1, headSha: head, baseSha: base }))
        .result,
    ).toMatchObject({
      kind: "forge",
      data: { resource: "prFiles", value: { files: [{ path: "a.ts" }] } },
    });
    const admitted = await source.readIdentity(root, repository, new AbortController().signal);
    const request = {
      command: "origin",
      args: ["api", "/repos/team/repo/pulls/7", "--method", "POST"],
      mode: "json" as const,
      signal: new AbortController().signal,
    };
    await expect(admitted.runner(request)).rejects.toMatchObject({ kind: "unsupported" });
    signedIn = "other@example.com";
    await expect(
      admitted.runner({ ...request, args: ["api", "/repos/team/repo/pulls/7", "--method", "GET"] }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    signedIn = "person@example.com";
    switchAfterApi = true;
    await expect(
      admitted.runner({ ...request, args: ["api", "/repos/team/repo/pulls/7", "--method", "GET"] }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  } finally {
    await runtime.close();
    source.close();
    await settings.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
