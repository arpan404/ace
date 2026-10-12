import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { command } from "./thread-creation-test-support.ts";
import { until } from "./projects-test-support.ts";
import { prDaemon, run } from "./pr-worktree-test-support.ts";

for (const fork of [false, true]) {
  test(`${fork ? "fork" : "same-repository"} PR tasks start on the pinned head with durable review context and leave personal edits intact`, async () => {
    const d = await prDaemon({ fork });
    try {
      const index = await readFile(join(d.h.home, ".git", "index"));
      const id = ThreadId.parse("pr-task");
      expect(await d.create(id)).toMatchObject({ ok: true, threadId: id });
      await d.h.engine.flush();
      const details = d.h.store.getThread(id)?.details;
      expect(details?.pullRequestWorkspace).toMatchObject({
        headSha: d.head,
        baseSha: d.base,
        headRepository: { owner: fork ? "contributor" : "octo" },
        ref: d.selection.ref,
      });
      const path = details?.worktree ?? "";
      expect(await run(path, "rev-parse", "HEAD")).toBe(d.head);
      expect(await readFile(join(path, "pr.txt"), "utf8")).toBe("PR-only content\n");
      expect(await run(d.h.home, "rev-parse", "HEAD")).toBe(d.base);
      expect(await readFile(join(d.h.home, "file.txt"), "utf8")).toBe("Personal dirty edit\n");
      expect(await readFile(join(d.h.home, ".git", "index"))).toEqual(index);
      expect(details?.linkedPrs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ number: 7, repo: d.selection.ref.repository }),
        ]),
      );
      expect(d.h.inputs[0]?.text).toContain("My first request");
      expect(d.h.inputs[0]?.text).toContain("Please preserve the review context.");
      expect(d.h.inputs[0]?.text).toContain("Handle empty input");
      expect(d.h.sessions[0]?.context.cwd).toBe(path);
      const trees = await d.trees();
      await d.reconnect();
      expect(await d.create(id)).toMatchObject({ ok: true, threadId: id });
      expect(await d.trees()).toBe(trees);
      expect(d.h.inputs).toHaveLength(1);
      await d.reopen();
      expect(await d.create(id)).toMatchObject({ ok: true, threadId: id });
      expect(d.h.store.getThread(id)?.details?.pullRequestWorkspace?.headSha).toBe(d.head);
      expect(d.h.store.getThread(id)?.details?.linkedPrs?.some((pr) => pr.number === 7)).toBe(true);
      expect(await d.trees()).toBe(trees);
    } finally {
      await d.close();
    }
  });
}

test("existing tasks keep their previous dirty checkout and repeated selection after restart reuses the verified PR worktree", async () => {
  const d = await prDaemon();
  try {
    const id = await d.h.create();
    const before = d.h.store.getThread(id)?.details?.worktree ?? d.h.home;
    await writeFile(join(before, "personal.txt"), "Keep me\n");
    expect(await d.work(id, "select-pr")).toMatchObject({ ok: true, threadId: id });
    const path = d.h.store.getThread(id)?.details?.worktree ?? "";
    expect(path).not.toBe(before);
    expect(await run(path, "rev-parse", "HEAD")).toBe(d.head);
    expect(await readFile(join(before, "personal.txt"), "utf8")).toBe("Keep me\n");
    const trees = await d.trees();
    await d.reopen();
    expect(await d.work(id, "same-pr-again")).toMatchObject({ ok: true });
    expect(await d.trees()).toBe(trees);
    expect(d.h.store.getThread(id)?.details?.worktree).toBe(path);
    expect(
      await command(d.client, "continue", {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "Continue the review" }],
      }),
    ).toMatchObject({ ok: true });
    await d.h.engine.flush();
    expect(d.h.sessions.at(-1)?.context.cwd).toBe(path);
    expect(d.h.inputs.at(-1)?.text).toContain("Please preserve the review context.");
  } finally {
    await d.close();
  }
});

test("a PR whose head moves after checkout is removed without admitting a task or provider prompt", async () => {
  const d = await prDaemon({
    configure(fixtures, { head }) {
      const entry = fixtures["repos/octo/ace/pulls/7"]?.[0];
      fixtures["repos/octo/ace/pulls/7"] = [
        entry ?? {},
        entry ?? {},
        {
          body: {
            ...(typeof entry?.body === "object" ? entry.body : {}),
            head: {
              sha: "c".repeat(40),
              ref: "feat/fix",
              repo: { owner: { login: "octo" }, name: "ace" },
            },
          },
        },
      ];
      fixtures[`repos/octo/ace/git/ref/heads/feat%2Ffix`] = [{ body: { object: { sha: head } } }];
    },
  });
  try {
    const trees = await d.trees();
    expect(await d.create("moving")).toMatchObject({ ok: false, error: "forge_conflict" });
    expect(d.h.store.getThread(ThreadId.parse("moving"))).toBeUndefined();
    expect(d.h.inputs).toHaveLength(0);
    expect(await d.trees()).toBe(trees);
    d.client.send({
      type: "worktree.creation.request",
      requestId: "failure",
      commandId: CommandId.parse("moving"),
      action: "get",
    });
    expect(await until(d.client, (m) => m.type === "worktree.creation.result")).toMatchObject({
      ok: true,
      progress: { state: "failed", cleanupComplete: true, actions: ["retry"] },
    });
  } finally {
    await d.close();
  }
});

for (const failure of ["missing", "deleted", "mismatch", "fetch"]) {
  test(`${failure} PR preparation stays recoverable and never starts in the local checkout`, async () => {
    const d = await prDaemon({
      matchRepository: failure === "mismatch",
      configure(fixtures, { source, head }) {
        if (failure === "missing")
          fixtures[source] = [{ status: 404, body: { message: "Not Found" } }];
        if (failure === "deleted") {
          const entry = fixtures["repos/octo/ace/pulls/7"]?.[0];
          fixtures["repos/octo/ace/pulls/7"] = [
            {
              body: {
                ...(typeof entry?.body === "object" ? entry.body : {}),
                head: { sha: head, ref: "feat/fix", repo: null },
              },
            },
          ];
        }
      },
    });
    try {
      if (failure === "fetch")
        await run(d.h.home, "remote", "set-url", "origin", join(d.h.home, "missing.git"));
      const trees = await d.trees();
      expect(await d.create(`failed-${failure}`)).toMatchObject({
        ok: false,
        error:
          failure === "mismatch"
            ? "repository_mismatch"
            : failure === "fetch"
              ? "git_remote_unreachable"
              : "forge_not_found",
      });
      expect(d.h.inputs).toHaveLength(0);
      expect(await d.trees()).toBe(trees);
      d.client.send({
        type: "worktree.creation.request",
        requestId: "fallback",
        commandId: CommandId.parse(`failed-${failure}`),
        action: "local",
      });
      expect(await until(d.client, (m) => m.type === "worktree.creation.result")).toMatchObject({
        ok: false,
        error: "settled",
      });
      expect(d.h.store.listThreads()).toHaveLength(0);
    } finally {
      await d.close();
    }
  });
}

test("cancelling a waiting gh read remains possible on the same socket and survives reconnect", async () => {
  const d = await prDaemon({
    configure(fixtures) {
      fixtures["repos/octo/ace/pulls/7"] = [{ wait: true }];
    },
  });
  try {
    d.client.send({ type: "command", command: d.draft("cancel-pr") });
    await until(d.client, (m) => m.type === "worktree.creation.progress" && m.step === "fetching");
    d.client.send({
      type: "worktree.creation.request",
      requestId: "cancel",
      commandId: CommandId.parse("cancel-pr"),
      action: "cancel",
    });
    expect(await until(d.client, (m) => m.type === "worktree.creation.result")).toMatchObject({
      ok: true,
    });
    expect(
      await until(d.client, (m) => m.type === "commandResult" && m.commandId === "cancel-pr"),
    ).toMatchObject({ ok: false, error: "worktree_cancelled" });
    await d.reconnect();
    d.client.send({
      type: "worktree.creation.request",
      requestId: "restored",
      commandId: CommandId.parse("cancel-pr"),
      action: "get",
    });
    expect(await until(d.client, (m) => m.type === "worktree.creation.result")).toMatchObject({
      progress: { state: "cancelled", actions: ["retry"] },
    });
    expect(d.h.inputs).toHaveLength(0);
    expect(d.h.store.listThreads()).toHaveLength(0);
  } finally {
    await d.close();
  }
});

test("a background task prevents PR selection from replacing its checkout or reporting the tree done", async () => {
  const d = await prDaemon();
  try {
    const id = await d.h.create();
    d.h.emit(id, {
      type: "background.started",
      agent: "root",
      task: "background",
      kind: "shell",
      title: "Still working",
      stoppable: true,
    });
    const before = d.h.store.getThread(id)?.details?.worktree;
    expect(await d.work(id, "live-tree")).toMatchObject({
      ok: false,
      error: "thread_tree_is_live",
    });
    expect(d.h.store.getThread(id)?.details?.worktree).toBe(before);
    expect(d.h.store.getThread(id)?.status.state).not.toBe("done");
  } finally {
    await d.close();
  }
});

test("existing-task PR preparation stays waiting until cancellation settles, then a fresh intent recovers after restart", async () => {
  const d = await prDaemon({
    configure(fixtures) {
      fixtures["repos/octo/ace/pulls/7"] = [{ wait: true }];
    },
  });
  try {
    const id = await d.h.create();
    const before = d.h.store.getThread(id)?.details?.worktree;
    d.client.send({
      type: "command",
      command: {
        id: CommandId.parse("prepare-existing"),
        deviceId: DeviceId.parse("device"),
        payload: { type: "forge.pr.worktree", threadId: id, pullRequest: d.selection },
      },
    });
    await until(d.client, (m) => m.type === "worktree.creation.progress" && m.step === "fetching");
    expect(d.h.store.getThread(id)?.status).toMatchObject({ state: "waiting", on: "queue" });
    d.client.send({
      type: "worktree.creation.request",
      requestId: "cancel-existing",
      commandId: CommandId.parse("prepare-existing"),
      action: "cancel",
    });
    expect(await until(d.client, (m) => m.type === "worktree.creation.result")).toMatchObject({
      ok: true,
    });
    expect(
      await until(
        d.client,
        (m) => m.type === "commandResult" && m.commandId === "prepare-existing",
      ),
    ).toMatchObject({ ok: false });
    expect(d.h.store.getThread(id)?.details?.worktree).toBe(before);
    expect(d.h.store.getThread(id)?.details?.worktreeCreation).toMatchObject({
      state: "cancelled",
    });
    // The source read can answer again. This is the gh process fixture, not a mocked owner.
    d.fixtures["repos/octo/ace/pulls/7"] = [
      {
        body: {
          number: 7,
          node_id: "PR_7",
          title: "Fix build",
          html_url: "https://github.com/octo/ace/pull/7",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          mergeable: true,
          head: { sha: d.head, ref: "feat/fix", repo: { owner: { login: "octo" }, name: "ace" } },
          base: { sha: d.base, ref: "main" },
          body: "Recovered review",
          user: { login: "octo" },
          labels: [],
          requested_reviewers: [],
          commits: 1,
          changed_files: 1,
        },
      },
    ];
    await writeFile(join(d.gh.dir, "fixtures.json"), JSON.stringify(d.fixtures));
    await d.reopen();
    expect(d.h.store.getThread(id)?.status.state).not.toBe("done");
    expect(await d.work(id, "recover-existing")).toMatchObject({ ok: true });
    expect(await run(d.h.store.getThread(id)?.details?.worktree ?? "", "rev-parse", "HEAD")).toBe(
      d.head,
    );
    expect(d.h.store.listThreads()).toHaveLength(1);
  } finally {
    await d.close();
  }
});
