import { performance } from "node:perf_hooks";
import { GitHubForge, type CommandRunner } from "../src/index.ts";

const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
const sha = "a".repeat(40);
const root = "repos/octo/ace";
function response(body: unknown, link?: string): string {
  return `HTTP/2.0 200 OK\r\nETag: "stable"\r\n${link ? `Link: ${link}\r\n` : ""}\r\n${JSON.stringify(body)}`;
}
async function measure(records: number, editing = false): Promise<void> {
  const pages = new Map<string, string>();
  pages.set(
    `${root}/pulls/7`,
    response({
      number: 7,
      node_id: "PR_7",
      title: "Fix",
      html_url: "https://github.com/octo/ace/pull/7",
      state: "open",
      draft: false,
      merged: false,
      head: { sha, ref: "fix" },
    }),
  );
  pages.set(
    `${root}/commits/${sha}/check-runs?per_page=100&filter=latest`,
    response({ check_runs: [] }),
  );
  pages.set(`${root}/commits/${sha}/statuses?per_page=100`, response([]));
  pages.set(`${root}/issues/7/comments?per_page=100`, response([]));
  pages.set(`${root}/pulls/7/reviews?per_page=100`, response([]));
  const count = Math.ceil(records / 100);
  const firstPath = `${root}/pulls/7/comments?per_page=100`;
  let editedFirst = "";
  let tick = 0;
  for (let page = 0; page < count; page++) {
    const path =
      page === 0
        ? `${root}/pulls/7/comments?per_page=100`
        : `${root}/pulls/7/comments?per_page=100&page=${page + 1}`;
    const comments = Array.from({ length: Math.min(100, records - page * 100) }, (_, index) => ({
      id: page * 100 + index + 1,
      body: "Please fix the error handling",
      user: { login: "alice" },
      updated_at: "today",
      path: "src/index.ts",
      line: 1,
    }));
    const link =
      page + 1 < count
        ? `<https://api.github.com/${root}/pulls/7/comments?per_page=100&page=${page + 2}>; rel="next"`
        : undefined;
    pages.set(path, response(comments, link));
    if (page === 0)
      editedFirst = response(
        comments.map((comment, index) =>
          index === 0 ? Object.assign({}, comment, { body: "Changed feedback" }) : comment,
        ),
        link,
      );
  }
  const graph = response({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  });
  const runner: CommandRunner = async (request) => {
    const path = request.args[1];
    const stdout =
      path === "graphql"
        ? graph
        : editing && path === firstPath
          ? tick % 2
            ? editedFirst
            : pages.get(firstPath)
          : request.args.includes('If-None-Match: "stable"')
            ? "HTTP/2.0 304 Not Modified\r\n\r\n"
            : pages.get(path ?? "");
    if (!stdout) throw new Error("Unexpected benchmark endpoint");
    return { code: 0, stdout, truncated: false };
  };
  const forge = new GitHubForge({ repository, runner, now: () => 1_000 });
  const signal = new AbortController().signal;
  const initial = await forge.status(7, signal);
  const countSamples = 2_000;
  const start = performance.now();
  for (let index = 0; index < countSamples; index++) {
    tick = index + 1;
    const current = await forge.status(7, signal);
    if ((!editing && current !== initial) || current.comments.length !== records)
      throw new Error("Revision cache changed unexpectedly");
  }
  const ms = performance.now() - start;
  console.log(
    JSON.stringify({
      name: `${editing ? "one edited page" : "warm status"}, ${records} comments, ${count} conditional pages`,
      samples: countSamples,
      opsPerSecond: Math.round((countSamples / ms) * 1_000),
      usPerOp: +((ms / countSamples) * 1_000).toFixed(2),
      peakRssMiB: +(process.resourceUsage().maxRSS / 1_024).toFixed(1),
    }),
  );
}
await measure(2);
await measure(2_000);

await measure(2, true);
await measure(100, true);
await measure(2_000, true);
