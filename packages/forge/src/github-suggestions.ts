import { z } from "zod";
import type { ForgeReviewAction } from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { decode, type ReviewIo } from "./review-io.ts";
import { applySuggestions, suggestionOf, type SuggestionEdit } from "./suggestions.ts";

type Apply = Extract<ForgeReviewAction, { kind: "suggestions.apply" }>;
const text = z.string().max(65_536);
const positive = z.number().int().positive();
const Pull = z.looseObject({
  head: z.looseObject({
    sha: text,
    ref: text,
    repo: z.looseObject({ full_name: text }).nullable(),
  }),
});
const InlineComment = z.looseObject({
  id: positive,
  body: text,
  path: text,
  line: positive.nullable().optional(),
  start_line: positive.nullable().optional(),
  side: text.nullable().optional(),
});
const Contents = z.looseObject({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string().max(2_000_000),
});
const Commit = z.looseObject({ parents: z.array(z.looseObject({ sha: text })).max(100) });
const Created = z.object({
  data: z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: text }) }) }),
});
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Applies suggested changes as one commit on the PR's head branch, through GitHub. The commit is
 * made only on the head the reviewer saw: a moved head refuses instead of overwriting.
 */
export class GitHubSuggestions {
  readonly #io: ReviewIo;
  constructor(io: ReviewIo) {
    this.#io = io;
  }
  async #pull(number: number, signal: AbortSignal) {
    return decode(Pull, (await this.#io.request(`${this.#io.root}/pulls/${number}`, signal)).body);
  }
  async #file(path: string, ref: string, signal: AbortSignal): Promise<string> {
    const page = await this.#io.request(
      `${this.#io.root}/contents/${encodePath(path)}?ref=${ref}`,
      signal,
    );
    const result = Contents.safeParse(page.body);
    // GitHub leaves `content` empty past 1 MB; a directory or a submodule has none.
    if (!result.success) throw new ForgeError("unprocessable", undefined, false);
    try {
      return utf8.decode(Buffer.from(result.data.content, "base64"));
    } catch {
      throw new ForgeError("unprocessable", undefined, false);
    }
  }
  /** Each touched file's text after the suggestions, computed from the head they were made on. */
  async #plan(number: number, action: Apply, signal: AbortSignal) {
    const comments = await this.#io.records(
      `${this.#io.root}/pulls/${number}/comments?per_page=100`,
      InlineComment,
      signal,
    );
    const edits = new Map<string, SuggestionEdit[]>();
    for (const id of new Set(action.commentIds)) {
      const comment = comments.find((c) => c.id === id);
      if (!comment) throw new ForgeError("not_found", undefined, false);
      // An outdated comment has no line on the current diff; a LEFT one is on removed lines.
      if (!comment.line || comment.side === "LEFT") throw new ForgeError("conflict");
      const lines = suggestionOf(comment.body);
      if (!lines) throw new ForgeError("unprocessable", undefined, false);
      const list = edits.get(comment.path) ?? [];
      list.push({ startLine: comment.start_line ?? comment.line, endLine: comment.line, lines });
      edits.set(comment.path, list);
    }
    const files = new Map<string, string>();
    for (const [path, list] of edits) {
      const next = applySuggestions(await this.#file(path, action.headSha, signal), list);
      if (next === undefined) throw new ForgeError("conflict");
      files.set(path, next);
    }
    return files;
  }
  async write(
    number: number,
    action: Apply,
    host: { pr: { state: string; headRefOid: string } },
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<void> {
    if (host.pr.state !== "OPEN" || host.pr.headRefOid !== action.headSha)
      throw new ForgeError("conflict");
    const pull = await this.#pull(number, signal);
    if (pull.head.sha !== action.headSha) throw new ForgeError("head_moved");
    if (!pull.head.repo) throw new ForgeError("fork_deleted");
    const files = await this.#plan(number, action, signal);
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    const [headline = "", ...rest] = action.message.trim().split(/\r?\n/);
    const body = rest.join("\n").trim();
    const response = await this.#io.request(
      "graphql",
      signal,
      {
        query:
          "mutation($input:CreateCommitOnBranchInput!){ createCommitOnBranch(input:$input){ commit { oid } } }",
        variables: {
          input: {
            clientMutationId: operationId,
            branch: { repositoryNameWithOwner: pull.head.repo.full_name, branchName: pull.head.ref },
            // GitHub refuses the commit unless the branch still points here.
            expectedHeadOid: action.headSha,
            message: { headline, ...(body ? { body } : {}) },
            fileChanges: {
              additions: [...files].map(([path, contents]) => ({
                path,
                contents: Buffer.from(contents, "utf8").toString("base64"),
              })),
            },
          },
        },
      },
      "POST",
      dispatch,
    );
    decode(Created, response.body);
  }
  /** Whether the head is now one commit on top of `headSha` carrying exactly these changes. */
  async reconcile(number: number, action: Apply, signal: AbortSignal): Promise<boolean> {
    const pull = await this.#pull(number, signal);
    if (pull.head.sha === action.headSha) return false;
    const commit = decode(
      Commit,
      (await this.#io.request(`${this.#io.root}/commits/${pull.head.sha}`, signal)).body,
    );
    if (commit.parents.length !== 1 || commit.parents[0]?.sha !== action.headSha) return false;
    const files = await this.#plan(number, action, signal);
    for (const [path, contents] of files)
      if ((await this.#file(path, pull.head.sha, signal)) !== contents) return false;
    return true;
  }
}
