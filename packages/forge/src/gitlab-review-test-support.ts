import type { CommandRequest, CommandResult } from "./command.ts";
export const repository = {
  forge: "gitlab" as const,
  host: "gitlab.com",
  owner: "group/sub",
  name: "ace",
};
export const head = "a".repeat(40);
export const base = "b".repeat(40);
export const start = "c".repeat(40);
export const root = "projects/group%2Fsub%2Face/merge_requests/7";
export const user = { id: 42, username: "alice", avatar_url: null };
export const mr = {
  iid: 7,
  title: "MR",
  state: "opened",
  updated_at: "2026-01-01T00:00:00Z",
  sha: head,
  diff_refs: { base_sha: base, start_sha: start, head_sha: head },
  changes_count: "1",
  reviewers: [user],
  author: { username: "bob" },
};
export const note = {
  id: 11,
  body: "Please fix",
  author: user,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  system: false,
  resolvable: true,
  resolved: false,
};
export const position = {
  base_sha: base,
  start_sha: start,
  head_sha: head,
  position_type: "text",
  old_path: "old.ts",
  new_path: "new.ts",
  old_line: null,
  new_line: 2,
};
export function reply(
  body: unknown,
  headers: Record<string, string> = { "x-next-page": "" },
): CommandResult {
  return {
    code: 0,
    truncated: false,
    stdout: `HTTP/2.0 200 OK\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("")}\r\n${JSON.stringify(body)}`,
  };
}
export function fixture(
  overrides: (request: CommandRequest) => CommandResult | undefined = () => undefined,
) {
  const seen: CommandRequest[] = [];
  const runner = async (request: CommandRequest) => {
    seen.push(request);
    const over = overrides(request);
    if (over) return over;
    const endpoint = request.args[1] ?? "";
    if (request.input !== undefined) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      if (endpoint.endsWith("/notes")) return reply({ ...note, id: 12 });
      if (endpoint.includes("/discussions"))
        return reply({ id: "abcdef", individual_note: false, notes: [{ ...note, position }] });
      if (/\/(approve|unapprove)$/.test(endpoint)) return reply({ approved_by: [] });
      return reply(mr);
    }
    if (endpoint === "user") return reply(user);
    if (endpoint.startsWith("users?")) return reply([user]);
    if (endpoint.includes("/discussions?"))
      return reply([{ id: "abcdef", individual_note: false, notes: [{ ...note, position }] }]);
    if (endpoint.endsWith("/approvals")) return reply({ approved: true, approved_by: [{ user }] });
    if (endpoint.endsWith("/approval_state"))
      return reply({ rules: [{ approved: true, approvals_required: 1 }] });
    if (endpoint.includes("/commits?"))
      return reply(
        [
          {
            id: head,
            message: "Change",
            author_name: "Alice",
            authored_date: note.created_at,
            web_url: "https://gitlab.com/group/sub/ace/-/commit/" + head,
          },
        ],
        { "x-total": "1", "x-next-page": "" },
      );
    if (endpoint.includes("/pipelines?")) return reply([]);
    if (endpoint.includes("/diffs?"))
      return reply([
        { old_path: "old.ts", new_path: "new.ts", diff: "@@ -1 +1,2 @@\n same\n+added" },
      ]);
    return reply(mr);
  };
  return { runner, seen };
}
