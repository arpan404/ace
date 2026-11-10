import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspaceId } from "@ace/protocol";
import { TeaWriter, teaWrites, isAdmittedApiRequest, type CommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { WorkspaceForgeActions } from "./workspace-forge-actions.ts";
import { ForgeResourceOwner } from "./forge-resource-owner.ts";
const head = "a".repeat(40),
  base = "b".repeat(40);
const signal = new AbortController().signal;
for (const forge of ["gitea", "forgejo"] as const) {
  test(`${forge} uncertain merge survives restart and reconciles without repeating the POST`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-tea-merge-"));
    const repository = { forge, host: "git.example", owner: "team", name: "app" };
    let store = new Store(join(root, "events.sqlite"));
    let merged = false;
    let posts = 0;
    let lose = true;
    let ci = "success";
    const runner: CommandRunner = async (r) => {
      expect(isAdmittedApiRequest("tea", r, "work", teaWrites)).toBe(true);
      const path = r.args[1] ?? "";
      if (r.input) {
        expect(JSON.parse(r.input)).toMatchObject({
          do: "squash",
          head_commit_id: head,
          force_merge: false,
          merge_when_checks_succeed: false,
        });
        r.dispatch?.prepare?.();
        r.dispatch?.record();
        posts++;
        merged = true;
        if (lose) throw new Error("Response lost after host accepted merge");
        return { code: 0, stdout: "", truncated: false, http: { status: 200, headers: {} } };
      }
      const body =
        path === "repos/team/app"
          ? {
              archived: false,
              permissions: { push: true },
              allow_merge_commits: true,
              allow_squash_merge: true,
              allow_rebase: true,
            }
          : path.includes("/status?")
            ? {
                sha: head,
                state: ci,
                total_count: 1,
                statuses: [{ id: 1, context: "build", status: ci }],
              }
            : /\/(comments|reviews)\?/.test(path)
              ? []
              : {
                  number: 7,
                  title: "Feature",
                  state: merged ? "closed" : "open",
                  merged,
                  mergeable: true,
                  head: { sha: head, ref: "feature" },
                  base: { sha: base, ref: "main" },
                };
      return {
        code: 0,
        stdout: JSON.stringify(body),
        truncated: false,
        http: { status: 200, headers: {} },
      };
    };
    const writer = new TeaWriter({ repository, login: "work", runner });
    const action = {
      type: "forge.hosted.merge",
      workspaceId: WorkspaceId.parse("workspace"),
      pr: { repository, number: 7 },
      headSha: head,
      method: "squash",
    } as const;
    let actions = new WorkspaceForgeActions(store, new ForgeResourceOwner(), () => 1000);
    try {
      await expect(writer.merge(7, base, "squash", signal)).rejects.toMatchObject({
        kind: "head_moved",
      });
      ci = "pending";
      await expect(writer.merge(7, head, "squash", signal)).rejects.toMatchObject({
        kind: "forbidden",
      });
      ci = "future";
      await expect(writer.merge(7, head, "squash", signal)).rejects.toMatchObject({
        kind: "forbidden",
      });
      expect(posts).toBe(0);
      ci = "success";
      expect(
        await actions.execute(
          action,
          writer,
          signal,
          () => true,
          () => {},
        ),
      ).toMatchObject({ ok: false, error: "forge_write_uncertain" });
      expect(posts).toBe(1);
      await store.close();
      store = new Store(join(root, "events.sqlite"));
      actions = new WorkspaceForgeActions(store, new ForgeResourceOwner(), () => 2000);
      expect(
        await actions.execute(
          action,
          writer,
          signal,
          () => true,
          () => {},
        ),
      ).toMatchObject({
        ok: true,
        code: "forge_action_reconciled",
        prStatus: { state: "merged", headSha: head },
      });
      expect(posts).toBe(1);
      merged = false;
      lose = false;
      await expect(writer.merge(7, head, "squash", signal)).resolves.toBeUndefined();
      expect(posts).toBe(2);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
