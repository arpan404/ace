import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { SourceControl } from "./source-control.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { ProjectRepositoryConfigs } from "./project-repository-config.ts";
const execute = promisify(execFile);
for (const [forge, host] of [
  ["gitea", "gitea.com"],
  ["forgejo", "codeberg.org"],
] as const) {
  test(`hidden ${forge} repository refuses issue writes before any CLI dispatch`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-tea-hidden-"));
    await execute("git", ["init", root]);
    await execute("git", ["-C", root, "remote", "add", "origin", `https://${host}/team/app.git`]);
    const store = new Store(join(root, "events.sqlite"));
    const workspaceId = store.createWorkspace(root, "Project");
    const repository = {
      forge,
      host,
      owner: "team",
      name: "app",
    } as const;
    const settings = new SettingsService({ dataDir: join(root, "settings") });
    await settings.set(
      "sourceControl.preferences",
      { hosts: [{ host: "github.com" }, { host, forge }], host, remote: "origin" },
      { kind: "global" },
    );
    const source = new SourceControl(
      settings,
      () => async () => {
        throw new Error("No CLI");
      },
      root,
    );
    let calls = 0;
    const runtime = new WorkspaceRuntime(store, root, () => 1000, {
      sourceControl: source,
      forgeRunner: () => async () => {
        calls++;
        throw new Error("CLI must not run");
      },
    });
    try {
      new ProjectRepositoryConfigs(store).set(workspaceId, {
        added: [],
        hidden: [repository],
        primary: null,
      });
      expect(
        await runtime.execute(
          Command.parse({
            id: "hidden",
            deviceId: "device",
            payload: {
              type: "forge.issue.write",
              workspaceId,
              repository,
              input: { action: "create", title: "Bug", body: "Never sent" },
            },
          }),
        ),
      ).toMatchObject({ ok: false, error: "repository_hidden", issueAction: { state: "failed" } });
      expect(calls).toBe(0);
    } finally {
      await runtime.close();
      source.close();
      await settings.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
