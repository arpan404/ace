import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { SourceControl } from "./source-control.ts";
import { ForgeBackends } from "./forge-backends.ts";
import { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import { WorkspaceActionRequest, ForgeRepository, SourceControlPreferences } from "@ace/protocol";
import type { CommandRequest, CommandRunner } from "@ace/forge";

const head = "a".repeat(40),
  base = "b".repeat(40);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A temp settings document, store and source control on one injected clock. */
async function harness(name: string, runner: CommandRunner, preferences: unknown) {
  const root = await mkdtemp(join(tmpdir(), `ace-${name}-`));
  const settings = new SettingsService({ dataDir: root });
  const store = new Store(join(root, "store.sqlite"));
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const source = new SourceControl(settings, () => runner, root, now);
  const runtime = new WorkspaceRuntime(store, root, now, {
    sourceControl: source,
    forgeRunner: () => runner,
  });
  cleanups.push(async () => {
    await runtime.close();
    source.close();
    await settings.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await settings.set("sourceControl.preferences", SourceControlPreferences.parse(preferences), {
    kind: "global",
  });
  const workspaceId = store.createWorkspace(root, name);
  const read = async (repository: ForgeRepository, operation: object) =>
    runtime.read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "read",
        operation: { workspaceId, repository, ...operation },
      }),
    );
  const backends = new ForgeBackends({
    git: {
      repositoryInfo: async () => {
        throw new Error("States never read the checkout");
      },
    },
    now,
    runner: () => runner,
    sourceControl: source,
    replyReceipts: new ForgeReplyReceipts(store),
    signal: new AbortController().signal,
  });
  return { root, settings, source, clock, read, backends };
}

const originPr = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});
const originRepository = ForgeRepository.parse({
  forge: "origin",
  host: "origin.cursor.com",
  owner: "team",
  name: "repo",
});

function originCli(state: { signedIn: string; probes: number; prs: Record<string, object> }) {
  const runner: CommandRunner = async (request) => {
    if (request.command !== "origin") throw new Error("Origin must never call another CLI");
    const args = request.args;
    if (args[0] === "auth" && args[1] === "status") {
      state.probes++;
      return { code: 0, stdout: JSON.stringify({ account: state.signedIn }), truncated: false };
    }
    if (args[0] !== "api" || args.at(-1) !== "GET") throw new Error("Unexpected mutation");
    const endpoint = args[1] ?? "";
    const number = /\/pulls\/(\d+)$/.exec(endpoint)?.[1];
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
        ? { pullRequests: [originPr()], nextPageToken: "" }
        : number && state.prs[number];
    if (!value)
      return {
        code: 1,
        stdout: JSON.stringify({ code: 5, message: "not found" }),
        truncated: false,
      };
    return { code: 0, stdout: JSON.stringify(value), truncated: false };
  };
  return runner;
}

const originPreferences = {
  hosts: [{ host: "origin.cursor.com", forge: "origin", account: "person@example.com" }],
  host: "origin.cursor.com",
  remote: "origin",
};

test("Origin browsing probes its account once per window and fails closed after a switch", async () => {
  const cli = { signedIn: "person@example.com", probes: 0, prs: { "7": originPr() } };
  const h = await harness("origin-browser", originCli(cli), originPreferences);
  const list = await h.read(originRepository, { op: "forge.pr.list", query: {} });
  expect(list.result).toMatchObject({
    kind: "forge",
    data: {
      resource: "prList",
      value: {
        items: [{ title: "Origin change", ref: { repository: { forge: "origin" }, number: 7 } }],
      },
    },
  });
  expect(
    (await h.read(originRepository, { op: "forge.pr.detail", number: 7 })).result,
  ).toMatchObject({
    kind: "forge",
    data: {
      resource: "prDetail",
      value: {
        readOnly: true,
        body: "Review description",
        capabilities: expect.arrayContaining(["reviews.read", "reviews.files"]),
      },
    },
  });
  expect(
    (
      await h.read(originRepository, {
        op: "forge.pr.files",
        number: 7,
        page: 1,
        headSha: head,
        baseSha: base,
      })
    ).result,
  ).toMatchObject({
    kind: "forge",
    data: { resource: "prFiles", value: { files: [{ path: "a.ts" }] } },
  });
  // Three reads inside one verification window cost one identity probe, not two per request.
  expect(cli.probes).toBe(1);

  const admitted = await h.source.readIdentity(
    h.root,
    originRepository,
    new AbortController().signal,
  );
  const request: CommandRequest = {
    command: "origin",
    args: ["api", "/repos/team/repo/pulls/7", "--method", "POST"],
    mode: "json",
    signal: new AbortController().signal,
  };
  await expect(admitted.runner(request)).rejects.toMatchObject({ kind: "unsupported" });

  // Once the window passes, the next read proves the account again and refuses a switch.
  cli.signedIn = "other@example.com";
  h.clock.now += 61_000;
  const get = { ...request, args: ["api", "/repos/team/repo/pulls/7", "--method", "GET"] };
  await expect(admitted.runner(get)).rejects.toMatchObject({ kind: "forbidden" });
  await expect(
    h.read(originRepository, { op: "forge.pr.detail", number: 7 }),
  ).rejects.toMatchObject({ kind: "forbidden" });
});

test("a background account probe that started before a detected switch never restores the old account", async () => {
  const cli = { signedIn: "person@example.com", probes: 0, prs: { "7": originPr() } };
  const reads = originCli(cli);
  // The next identity probe, when held, answers only once the test releases it.
  let held: PromiseWithResolvers<string> | undefined;
  const runner: CommandRunner = async (request) => {
    if (request.args[0] === "auth" && held) {
      const gate = held;
      held = undefined;
      cli.probes++;
      const account = await gate.promise;
      return { code: 0, stdout: JSON.stringify({ account }), truncated: false };
    }
    return reads(request);
  };
  const h = await harness("origin-race", runner, originPreferences);
  const signal = new AbortController().signal;
  await h.source.readIdentity(h.root, originRepository, signal);
  expect(cli.probes).toBe(1);

  // Past the verification window, the cached account is reused while a probe runs behind it.
  h.clock.now += 61_000;
  held = Promise.withResolvers<string>();
  const stale = held;
  const reused = await h.source.readIdentity(h.root, originRepository, signal);
  expect(reused.account).toBe("person@example.com");
  expect(cli.probes).toBe(2);

  // The account switches; the next read's own probe sees it and fails closed.
  cli.signedIn = "other@example.com";
  const get: CommandRequest = {
    command: "origin",
    args: ["api", "/repos/team/repo/pulls/7", "--method", "GET"],
    mode: "json",
    signal,
  };
  await expect(reused.runner(get)).rejects.toMatchObject({ kind: "forbidden" });

  // The probe that began before the switch now answers with the old account.
  stale.resolve("person@example.com");
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Its stale answer must not admit the next read: the account is proved again and refused.
  const before = cli.probes;
  await expect(h.source.readIdentity(h.root, originRepository, signal)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(cli.probes).toBe(before + 1);
});

test("a settings change makes the next Origin read prove its account again", async () => {
  const cli = { signedIn: "person@example.com", probes: 0, prs: { "7": originPr() } };
  const h = await harness("origin-signal", originCli(cli), originPreferences);
  await h.read(originRepository, { op: "forge.pr.detail", number: 7 });
  expect(cli.probes).toBe(1);
  await h.settings.set(
    "sourceControl.preferences",
    { ...originPreferences, hosts: [{ host: "origin.cursor.com", forge: "origin" }] },
    { kind: "global" },
  );
  await h.read(originRepository, { op: "forge.pr.detail", number: 7 });
  expect(cli.probes).toBe(2);
});

test("Origin state refresh skips a state it can't name and keeps reading the rest", async () => {
  const cli = {
    signedIn: "person@example.com",
    probes: 0,
    prs: {
      "7": originPr(),
      "8": originPr({ number: "8", state: "queued" }),
      "9": originPr({ number: "9", merged: true, state: "closed" }),
    },
  };
  const h = await harness("origin-states", originCli(cli), originPreferences);
  const states = await h.backends.states(
    h.root,
    originRepository,
    [7, 8, 9, 10],
    new AbortController().signal,
  );
  expect(states.get(7)?.state).toBe("open");
  expect(states.has(8)).toBe(false);
  expect(states.get(9)?.state).toBe("merged");
  expect(states.get(10)).toBeNull();
});

const gitlabRepository = ForgeRepository.parse({
  forge: "gitlab",
  host: "git.example.com",
  owner: "group/sub",
  name: "repo",
});
const mr = (iid: number, over: Record<string, unknown> = {}) => ({
  iid,
  title: `Change ${iid}`,
  description: "MR body",
  state: "opened",
  updated_at: "2026-11-04T12:00:00Z",
  created_at: "2026-11-04T12:00:00Z",
  source_branch: "feature",
  target_branch: "main",
  author: { username: "a.user_1" },
  sha: head,
  diff_refs: { base_sha: base, head_sha: head, start_sha: base },
  changes_count: "1",
  ...over,
});

const http = (status: string, body: unknown, headers: Record<string, string> = {}) => ({
  code: status.startsWith("200") ? 0 : 1,
  stdout: [`HTTP/2.0 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)]
    .join("\r\n")
    .concat("\r\n\r\n", JSON.stringify(body)),
  truncated: false,
});

function glab(mrs: Record<number, object>, seen: string[]): CommandRunner {
  return async (request) => {
    if (request.command !== "glab") throw new Error("GitLab must never call another CLI");
    const endpoint = request.args[1] ?? "";
    seen.push(endpoint);
    if (endpoint === "user") return http("200 OK", { username: "a.user_1" });
    if (!request.args.includes("GET")) throw new Error("Unexpected mutation");
    if (
      endpoint.includes("/discussions?") ||
      endpoint.includes("/commits?") ||
      endpoint.includes("/pipelines?")
    )
      return http("200 OK", [], { "x-total": "0", "x-next-page": "" });
    if (endpoint.endsWith("/approvals"))
      return http("200 OK", { approved_by: [], approved: false });
    if (endpoint.endsWith("/approval_state")) return http("200 OK", { rules: [] });
    if (endpoint.includes("/diffs?"))
      return http(
        "200 OK",
        [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" }],
        { "x-total": "1", "x-next-page": "" },
      );
    if (endpoint.includes("merge_requests?"))
      return http("200 OK", endpoint.includes("per_page=1&") ? [] : Object.values(mrs), {
        "x-total": String(Object.keys(mrs).length),
      });
    const iid = Number(/merge_requests\/(\d+)$/.exec(endpoint)?.[1]);
    const found = mrs[iid];
    return found ? http("200 OK", found) : http("404 Not Found", { message: "404 Not found" });
  };
}

const gitlabPreferences = {
  hosts: [
    { host: "github.com" },
    { host: "git.example.com", forge: "gitlab", account: "a.user_1" },
  ],
  host: "git.example.com",
  remote: "origin",
};

test("GitLab merge requests browse through glab with GET-only, pinned reads", async () => {
  const seen: string[] = [];
  const h = await harness("gitlab-browser", glab({ 3: mr(3) }, seen), gitlabPreferences);
  expect((await h.read(gitlabRepository, { op: "forge.pr.list", query: {} })).result).toMatchObject(
    {
      kind: "forge",
      data: {
        resource: "prList",
        value: {
          items: [
            {
              title: "Change 3",
              url: "https://git.example.com/group/sub/repo/-/merge_requests/3",
              ref: { repository: { forge: "gitlab", owner: "group/sub" }, number: 3 },
            },
          ],
        },
      },
    },
  );
  expect(
    (await h.read(gitlabRepository, { op: "forge.pr.detail", number: 3 })).result,
  ).toMatchObject({
    kind: "forge",
    data: {
      resource: "prDetail",
      value: {
        body: "MR body",
        changedFiles: 1,
        capabilities: expect.arrayContaining(["reviews.read", "reviews.files"]),
      },
    },
  });
  expect(
    (
      await h.read(gitlabRepository, {
        op: "forge.pr.files",
        number: 3,
        page: 1,
        headSha: head,
        baseSha: base,
      })
    ).result,
  ).toMatchObject({
    kind: "forge",
    data: { resource: "prFiles", value: { files: [{ path: "a.ts", additions: 1, deletions: 1 }] } },
  });
  expect(seen.filter((endpoint) => endpoint === "user")).toHaveLength(1);
  expect(seen.some((endpoint) => endpoint.endsWith("/changes"))).toBe(false);
});

test("GitLab state refresh skips a locked merge request instead of failing the batch", async () => {
  const seen: string[] = [];
  const h = await harness(
    "gitlab-states",
    glab({ 1: mr(1), 2: mr(2, { state: "locked" }), 3: mr(3, { state: "merged" }) }, seen),
    gitlabPreferences,
  );
  const states = await h.backends.states(
    h.root,
    gitlabRepository,
    [1, 2, 3, 4],
    new AbortController().signal,
  );
  expect(states.get(1)).toMatchObject({
    state: "open",
    url: "https://git.example.com/group/sub/repo/-/merge_requests/1",
  });
  expect(states.has(2)).toBe(false);
  expect(states.get(3)?.state).toBe("merged");
  expect(states.get(4)).toBeNull();
});
