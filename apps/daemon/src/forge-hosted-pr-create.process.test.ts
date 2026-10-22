import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, type CommandPayload } from "@ace/protocol";
import { fakeGh, pr, repository, sha, standard, type Fixtures } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const upstream = { ...repository, owner: "acme" };
const lookup = (repo: string, owner: string) =>
  `repos/${repo}/pulls?${new URLSearchParams({ state: "open", head: `${owner}:feature/card`, base: "main", per_page: "10" })}`;
const opened = { ...pr, number: 7, head: { sha, ref: "feature/card" }, base: { ref: "main" } };
const metadata = (parent?: { owner: string; name: string }, name = "ace") => ({
  body: {
    name,
    owner: { login: "octo" },
    default_branch: "main",
    parent: parent
      ? { name: parent.name, owner: { login: parent.owner }, default_branch: "main" }
      : null,
  },
});

/** A project on `origin` (octo/ace) whose pull requests open with no thread. */
async function environment(records: Fixtures, origin = "octo/ace") {
  const gh = await fakeGh({ ...standard(), ...records });
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-create-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", `https://github.com/${origin}.git`]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  const create = (
    extra: Partial<Extract<CommandPayload, { type: "forge.hosted.pr.create" }>> = {},
  ) =>
    runtime.execute(
      Command.parse({
        id: `create-${Math.random()}`,
        deviceId: "device",
        payload: {
          type: "forge.hosted.pr.create",
          workspaceId,
          repository,
          base: "main",
          head: { owner: "octo", name: "ace", branch: "feature/card" },
          title: "Add the card",
          body: "## Summary\n\nCloses #3",
          ...extra,
        },
      }),
      () => true,
    );
  return {
    gh,
    workspaceId,
    runtime,
    create,
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const sent = async (gh: Awaited<ReturnType<typeof fakeGh>>, path: string) =>
  (await gh.requests()).filter((request) => request.path === path && !request.args.includes("GET"));

test("a PR opened from the Pull requests page takes its labels, milestone and reviewers", async () => {
  const env = await environment({
    "repos/octo/ace": [metadata()],
    [lookup("octo/ace", "octo")]: [{ body: [] }],
    "repos/octo/ace/pulls": [{ status: 201, body: opened }],
    "repos/octo/ace/issues/7": [{ body: { number: 7 } }],
    "repos/octo/ace/pulls/7/requested_reviewers": [
      { status: 201, body: { requested_reviewers: [{ login: "hubot" }] } },
    ],
  });
  try {
    const result = await env.create({
      draft: true,
      labels: ["bug"],
      milestone: 4,
      reviewers: ["hubot"],
    });
    expect(result).toMatchObject({ ok: true, pr: { number: 7 } });
    expect(result.code).toBeUndefined();
    expect((await sent(env.gh, "repos/octo/ace/pulls"))[0]?.body).toEqual({
      head: "feature/card",
      base: "main",
      title: "Add the card",
      body: "## Summary\n\nCloses #3",
      draft: true,
    });
    expect((await sent(env.gh, "repos/octo/ace/issues/7"))[0]?.body).toEqual({
      labels: ["bug"],
      milestone: 4,
    });
    expect((await sent(env.gh, "repos/octo/ace/pulls/7/requested_reviewers"))[0]?.body).toEqual({
      reviewers: ["hubot"],
    });
  } finally {
    await env.close();
  }
});

test("the branch's open PR into the same base is returned, never opened twice", async () => {
  const env = await environment({
    "repos/octo/ace": [metadata()],
    [lookup("octo/ace", "octo")]: [{ body: [opened] }],
  });
  try {
    expect(await env.create()).toMatchObject({ ok: true, pr: { number: 7 }, prExisting: true });
    expect(await sent(env.gh, "repos/octo/ace/pulls")).toEqual([]);
  } finally {
    await env.close();
  }
});

test("a label GitHub refuses leaves the PR open and the result says what's missing", async () => {
  const env = await environment({
    "repos/octo/ace": [metadata()],
    [lookup("octo/ace", "octo")]: [{ body: [] }],
    "repos/octo/ace/pulls": [{ status: 201, body: opened }],
    "repos/octo/ace/issues/7": [{ status: 422, body: { message: "Validation Failed" } }],
  });
  try {
    expect(await env.create({ labels: ["nope"] })).toMatchObject({
      ok: true,
      pr: { number: 7 },
      code: "forge_pr_details_incomplete",
    });
  } finally {
    await env.close();
  }
});

test("a fork's new PR reads its parent's branches and opens there from fork-owner:branch", async () => {
  const env = await environment({
    "repos/octo/ace": [metadata({ owner: "acme", name: "ace" })],
    "repos/acme/ace/branches?per_page=100": [{ body: [{ name: "main", commit: { sha } }] }],
    "repos/octo/ace/branches?per_page=100": [
      {
        body: [
          { name: "main", commit: { sha } },
          { name: "feature/card", commit: { sha } },
        ],
      },
    ],
    "graphql:pullRequestTemplates": [
      {
        body: {
          data: {
            repository: {
              pullRequestTemplates: [{ filename: "pull_request_template.md", body: "## Why" }],
            },
          },
        },
      },
    ],
    [lookup("acme/ace", "octo")]: [{ body: [] }],
    "repos/acme/ace/pulls": [{ status: 201, body: { ...opened, number: 12 } }],
  });
  try {
    const read = await env.runtime.read({
      type: "workspace.request",
      requestId: "context",
      operation: { op: "forge.pr.new-context", workspaceId: env.workspaceId },
    });
    expect(read).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "newPrContext",
          value: {
            base: { repository: upstream, defaultBranch: "main" },
            head: { repository, branches: [{ name: "main" }, { name: "feature/card" }] },
            template: "## Why",
          },
        },
      },
    });
    const result = await env.create({ repository: upstream });
    expect(result).toMatchObject({ ok: true, pr: { repository: upstream, number: 12 } });
    expect((await sent(env.gh, "repos/acme/ace/pulls"))[0]?.body).toMatchObject({
      head: "octo:feature/card",
      base: "main",
    });
  } finally {
    await env.close();
  }
});

test("a PR aimed at a repository the project doesn't push to is refused unsent", async () => {
  const env = await environment({ "repos/octo/ace": [metadata()] });
  try {
    expect(await env.create({ repository: upstream })).toMatchObject({
      ok: false,
      error: "repository_mismatch",
    });
    expect(await sent(env.gh, "repos/acme/ace/pulls")).toEqual([]);
  } finally {
    await env.close();
  }
});

test("a create retried after a lost answer adds what it asked for to the PR the first one opened", async () => {
  // The first attempt opened #7 but its answer never came back; this one finds #7.
  const env = await environment({
    "repos/octo/ace": [metadata()],
    [lookup("octo/ace", "octo")]: [{ body: [opened] }],
    "repos/octo/ace/issues/7/labels": [{ body: [{ name: "bug" }] }],
    "repos/octo/ace/issues/7/assignees": [{ status: 201, body: { number: 7 } }],
    "repos/octo/ace/issues/7": [{ body: { number: 7 } }],
    "repos/octo/ace/pulls/7/requested_reviewers": [
      { status: 201, body: { requested_reviewers: [{ login: "hubot" }] } },
    ],
  });
  try {
    const result = await env.create({
      labels: ["bug"],
      assignees: ["octo"],
      milestone: 4,
      reviewers: ["hubot"],
    });
    expect(result).toMatchObject({ ok: true, pr: { number: 7 }, prExisting: true });
    expect(result.code).toBeUndefined();
    expect(await sent(env.gh, "repos/octo/ace/pulls")).toEqual([]);
    // Added alongside what #7 already has, never replacing it.
    expect((await sent(env.gh, "repos/octo/ace/issues/7/labels"))[0]?.body).toEqual({
      labels: ["bug"],
    });
    expect((await sent(env.gh, "repos/octo/ace/issues/7/assignees"))[0]?.body).toEqual({
      assignees: ["octo"],
    });
    expect((await sent(env.gh, "repos/octo/ace/issues/7"))[0]?.body).toEqual({ milestone: 4 });
    expect((await sent(env.gh, "repos/octo/ace/pulls/7/requested_reviewers"))[0]?.body).toEqual({
      reviewers: ["hubot"],
    });
  } finally {
    await env.close();
  }
});

test("details GitHub refuses on the existing PR are reported, not dropped", async () => {
  const env = await environment({
    "repos/octo/ace": [metadata()],
    [lookup("octo/ace", "octo")]: [{ body: [opened] }],
    "repos/octo/ace/issues/7/labels": [{ status: 422, body: { message: "Validation Failed" } }],
  });
  try {
    expect(await env.create({ labels: ["nope"] })).toMatchObject({
      ok: true,
      prExisting: true,
      code: "forge_pr_details_incomplete",
    });
  } finally {
    await env.close();
  }
});

test("a fork sharing its parent's owner opens on the parent from its own branch", async () => {
  // The project pushes to octo/ace-fork, a fork of octo/ace: both are owned by octo.
  const env = await environment(
    {
      "repos/octo/ace-fork": [metadata({ owner: "octo", name: "ace" }, "ace-fork")],
      [lookup("octo/ace", "octo")]: [
        // The parent's own feature/card PR shares owner:branch with the fork's branch.
        {
          body: [
            {
              ...opened,
              head: { ...opened.head, repo: { name: "ace", owner: { login: "octo" } } },
            },
          ],
        },
      ],
      "repos/octo/ace/pulls": [{ status: 201, body: { ...opened, number: 12 } }],
    },
    "octo/ace-fork",
  );
  try {
    const result = await env.create({
      repository,
      head: { owner: "octo", name: "ace-fork", branch: "feature/card" },
    });
    expect(result).toMatchObject({ ok: true, pr: { repository, number: 12 } });
    expect(result).not.toHaveProperty("prExisting");
    expect((await sent(env.gh, "repos/octo/ace/pulls"))[0]?.body).toMatchObject({
      head: "octo:feature/card",
      head_repo: "ace-fork",
      base: "main",
    });
  } finally {
    await env.close();
  }
});
