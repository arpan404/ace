import { expect, test } from "vitest";
import { TeaWriter } from "./tea-writes.ts";
import type { CommandRequest, CommandRunner } from "./command.ts";

const head = "a".repeat(40);
const signal = new AbortController().signal;
const repository = { forge: "gitea" as const, host: "git.example", owner: "team", name: "app" };

/** A Gitea host per its API v1 (gitea.com/swagger.v1.json), recording every write sent. */
function host(pull: Record<string, unknown>) {
  const posts: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    const path = request.args[1] ?? "";
    if (request.input !== undefined) {
      posts.push(request);
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
          ? { sha: head, state: "success", total_count: 0, statuses: [] }
          : /\/(comments|reviews)\?/.test(path)
            ? []
            : {
                number: 7,
                title: "Feature",
                state: "open",
                merged: false,
                mergeable: true,
                head: { sha: head, ref: "feature" },
                base: { sha: "b".repeat(40), ref: "main" },
                ...pull,
              };
    return {
      code: 0,
      stdout: JSON.stringify(body),
      truncated: false,
      http: { status: 200, headers: {} },
    };
  };
  return { posts, writer: new TeaWriter({ repository, login: "work", runner }) };
}

test("a Gitea draft reads as a draft and is refused before any merge is sent", async () => {
  for (const draft of [{ draft: true }, { title: "WIP: Feature" }]) {
    const { writer, posts } = host({ ...draft, mergeable: true });
    expect(await writer.prMergeState(7, signal)).toMatchObject({
      state: "DRAFT",
      mergeState: "DRAFT",
    });
    expect((await writer.status(7, signal)).mergeability).toBe("unknown");
    await expect(writer.merge(7, head, "merge", signal)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(posts).toEqual([]);
  }
});

test("a conflict-free Gitea PR is not clean and its review decision is unknown, since protection and approvals aren't read", async () => {
  const { writer, posts } = host({ mergeable: true });
  expect(await writer.prMergeState(7, signal)).toMatchObject({
    state: "OPEN",
    mergeState: "UNKNOWN",
    reviewDecision: "UNKNOWN",
    checksState: "NONE",
  });
  // The host still enforces its own rules on the pinned merge.
  await writer.merge(7, head, "squash", signal);
  expect(posts.map((post) => JSON.parse(post.input ?? "{}"))).toEqual([
    expect.objectContaining({ do: "squash", head_commit_id: head }),
  ]);
});

test("a Gitea PR that isn't known free of conflicts is refused before any merge is sent", async () => {
  const { writer, posts } = host({ mergeable: false });
  await expect(writer.merge(7, head, "merge", signal)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(posts).toEqual([]);
});
