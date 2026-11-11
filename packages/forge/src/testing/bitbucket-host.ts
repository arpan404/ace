import type { CommandRequest, CommandResult, CommandRunner } from "../command.ts";

/*
 * A Bitbucket Cloud host as bkt answers it, from hand-made replies in the shapes of
 * developer.atlassian.com/cloud/bitbucket/rest (no accounts, no network). bkt prints a 2xx body
 * on stdout and `Error: <status> <reason>` on stderr otherwise; the runner turns that into
 * `http.status`, as `createCommandRunner` does.
 */

export const head = "a".repeat(40);
export const base = "b".repeat(40);
export const root = "/2.0/repositories/team/app";
export const repository = {
  forge: "bitbucket" as const,
  host: "bitbucket.org",
  owner: "team",
  name: "app",
};
export const me = { uuid: "{me-1}", nickname: "Ada", display_name: "Ada L", username: "ada" };
export const author = { uuid: "{bob-2}", nickname: "Bob", display_name: "Bob B" };

/** A pull request as GET …/pullrequests/<id> returns it. */
export function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: "Add parser",
    description: "Body",
    state: "OPEN",
    draft: false,
    author,
    source: {
      branch: { name: "feature" },
      commit: { hash: head.slice(0, 12) },
      repository: { full_name: "team/app" },
    },
    destination: {
      branch: { name: "main" },
      commit: { hash: base.slice(0, 12) },
      repository: { full_name: "team/app" },
    },
    participants: [],
    created_on: "2026-11-01T10:00:00Z",
    updated_on: "2026-11-02T10:00:00Z",
    ...overrides,
  };
}

export type Write = { method: string; endpoint: string; body: unknown };
/** What the host does with a write: answer with a status, or never answer. */
export type WriteReply = { status: number; identityChanged?: true } | { lost: true };

export type FakeBitbucket = {
  runner: CommandRunner;
  writes: Write[];
  requests: CommandRequest[];
  /** GET replies by endpoint; a function sees how often that endpoint was read. */
  replies: Map<string, unknown>;
};

/**
 * A fake host answering GETs from `replies` (404 for anything else) and recording every write.
 * Defaults hold one open pull request #7 with no comments, statuses or participants.
 */
export function bitbucketHost(
  options: {
    replies?: Record<string, unknown>;
    write?: (write: Write) => WriteReply;
  } = {},
): FakeBitbucket {
  const replies = new Map<string, unknown>(
    Object.entries({
      "/2.0/user": me,
      [`${root}/pullrequests/7`]: pullRequest(),
      [`${root}/pullrequests/7/commits?pagelen=1`]: { values: [{ hash: head }] },
      [`${root}/commit/${base.slice(0, 12)}`]: { hash: base },
      [`${root}/pullrequests/7/comments?pagelen=100`]: { values: [] },
      [`${root}/pullrequests/7/statuses?pagelen=100`]: { values: [] },
      ...options.replies,
    }),
  );
  const writes: Write[] = [];
  const requests: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    requests.push(request);
    const [, endpoint = "", , method] = request.args;
    if (method !== "GET") {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      const input = request.args[7];
      const write = { method: method ?? "", endpoint, body: input ? JSON.parse(input) : undefined };
      writes.push(write);
      const reply = options.write?.(write) ?? { status: 200 };
      if ("lost" in reply) throw new Error("response lost after sending");
      return answer(reply.status, { id: 99 }, reply.identityChanged);
    }
    const reply = replies.get(endpoint);
    if (reply === undefined) return answer(404, { type: "error" });
    const value = typeof reply === "function" ? (reply as () => unknown)() : reply;
    if (value instanceof Error) return answer(Number(value.message), { type: "error" });
    return answer(200, value);
  };
  return { runner, writes, requests, replies };
}

function answer(status: number, body: unknown, identityChanged?: true): CommandResult {
  return {
    code: status < 300 ? 0 : 1,
    stdout: status < 300 ? JSON.stringify(body) : "",
    truncated: false,
    ...(status < 300 ? {} : { http: { status, headers: {} } }),
    ...(identityChanged ? { identityChanged } : {}),
  };
}
