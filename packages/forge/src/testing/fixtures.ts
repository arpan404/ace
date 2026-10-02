import { mkdtemp, writeFile, readFile, rm, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCommandRunner, GitHubForge } from "../index.ts";
import type { ForgeRepository } from "@ace/protocol/forge";

export const repository: ForgeRepository = {
  forge: "github",
  host: "github.com",
  owner: "octo",
  name: "ace",
};
export const sha = "a".repeat(40);
export const nextSha = "b".repeat(40);
export const pr = {
  number: 7,
  node_id: "PR_7",
  title: "Fix build",
  html_url: "https://github.com/octo/ace/pull/7",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  mergeable: true,
  head: { sha, ref: "feat/fix" },
  future_field: { useful: true },
};
export const check = {
  id: 11,
  name: "test",
  status: "completed",
  conclusion: "failure",
  completed_at: "2026-10-02T10:00:00Z",
  details_url: "https://github.com/octo/ace/actions/runs/42/job/99",
};
export const comment = {
  id: 13,
  body: "Handle empty input",
  user: { login: "reviewer" },
  path: "src/main.ts",
  line: 12,
  updated_at: "2026-10-02T10:00:00Z",
};
export function threads(
  nodes: unknown[] = [],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      repository: {
        pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } },
      },
    },
  };
}
export function thread(resolved = false, outdated = false) {
  return {
    id: "THREAD_1",
    isResolved: resolved,
    isOutdated: outdated,
    path: "src/main.ts",
    line: 12,
    comments: {
      nodes: [
        {
          databaseId: 13,
          body: comment.body,
          author: { login: "reviewer" },
          updatedAt: comment.updated_at,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}
export type Response = {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
  code?: number;
  raw?: string;
  stderr?: string;
  repeat?: number;
  text?: string;
  suffix?: string;
  wait?: boolean;
};
export type Fixtures = Record<string, Response[]>;
export function standard(): Fixtures {
  return {
    "repos/octo/ace/pulls/7": [{ body: pr, headers: { ETag: '"pr1"' } }],
    [`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`]: [
      { body: { check_runs: [check] }, headers: { ETag: '"checks1"' } },
    ],
    [`repos/octo/ace/commits/${sha}/statuses?per_page=100`]: [{ body: [] }],
    "repos/octo/ace/pulls/7/comments?per_page=100": [
      { body: [comment], headers: { ETag: '"comments1"' } },
    ],
    "repos/octo/ace/issues/7/comments?per_page=100": [{ body: [] }],
    graphql: [{ body: threads([thread()]) }],
    "repos/octo/ace/actions/jobs/99/logs": [{ raw: "test failed\n" }],
  };
}
export async function fakeGh(fixtures: Fixtures, options: { maxBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ace-forge-"));
  const executable = join(dir, "gh");
  const config = join(dir, "fixtures.json");
  const state = join(dir, "state.json");
  await copyFile(new URL("./fake-gh.mjs", import.meta.url), executable);
  await chmod(executable, 0o755);
  await writeFile(config, JSON.stringify(fixtures));
  const runner = createCommandRunner({
    cwd: dir,
    env: { FORGE_FIXTURE: config, FORGE_STATE: state },
    ...options,
  });
  const forge = new GitHubForge({ repository, runner, command: executable, now: () => 1_000 });
  return {
    dir,
    runner,
    forge,
    executable,
    async requests() {
      return z
        .object({
          requests: z.array(
            z.object({ path: z.string(), args: z.array(z.string()), body: z.unknown().optional() }),
          ),
        })
        .parse(JSON.parse(await readFile(state, "utf8"))).requests;
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
