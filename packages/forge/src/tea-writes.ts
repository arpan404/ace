import { z } from "zod";
import { ForgeComment } from "@ace/protocol/forge";
import { ForgeMergeState, type ForgeMergeCommit } from "@ace/protocol/forge-merge-state";
import type { CommandRunner } from "./command.ts";
import type { MergeMethod } from "./api.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import { TeaReader } from "./tea-reader.ts";
import { decode, pull, sha } from "./tea-records.ts";
import { teaGet, teaResponse } from "./tea-api.ts";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";
import type { HostApiWrite } from "./read-only-api.ts";

/** Only conversation comments and head-pinned merges, never force/auto merge or credential calls. */
export const teaWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues\/\d+\/comments$/ },
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/pulls\/\d+\/merge$/ },
];
const comment = z.looseObject({
  id: z.number().int().positive(),
  body: z.string(),
  user: z.object({ login: z.string() }),
  created_at: z.string(),
  updated_at: z.string(),
});
const metadata = z.object({
  permissions: z.object({ push: z.boolean() }),
  allow_merge_commits: z.boolean(),
  allow_squash_merge: z.boolean(),
  allow_rebase: z.boolean(),
});

export class TeaWriter {
  readonly reader: TeaReader;
  private options: ConstructorParameters<typeof TeaReader>[0];
  private root: string;
  constructor(options: ConstructorParameters<typeof TeaReader>[0]) {
    this.options = options;
    this.reader = new TeaReader(options);
    this.root = `repos/${encodeURIComponent(options.repository.owner)}/${encodeURIComponent(options.repository.name)}`;
  }
  private get(path: string, signal: AbortSignal) {
    return teaGet(this.options.runner, this.options.login, `${this.root}${path}`, signal);
  }
  private async write(path: string, body: object, signal: AbortSignal, dispatch: WriteDispatch) {
    const result = await this.options.runner({
      command: "tea",
      args: [
        "api",
        `${this.root}${path}`,
        "--method",
        "POST",
        "--login",
        this.options.login,
        "--include",
        "--data",
        "@-",
      ],
      input: JSON.stringify(body),
      mode: "json",
      signal,
      dispatch,
    });
    if (result.identityChanged) throw new ForgeError("outcome_uncertain");
    return teaResponse(result);
  }
  /** Complete bounded conversation snapshot for unambiguous post-write reconciliation. */
  async comments(number: number, signal: AbortSignal) {
    await this.reader.status(number, signal);
    const result = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.get(`/issues/${number}/comments?page=${page}&limit=100`, signal);
      const data = decode(z.array(comment).max(100), response.body);
      result.push(
        ...data.map((c) =>
          decode(ForgeComment, {
            id: c.id,
            kind: "issue",
            body: clipText(c.body),
            author: clipText(c.user.login),
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            file: null,
            line: null,
            replyTo: null,
          }),
        ),
      );
      if (response.total !== undefined ? page * 100 >= response.total : data.length < 100)
        return result;
    }
    throw new ForgeError("limit");
  }
  async conversation(number: number, body: string, signal: AbortSignal, dispatch: WriteDispatch) {
    z.string().min(1).max(65536).parse(body);
    // Verify the issues endpoint still denotes this PR before posting.
    const p = await this.reader.status(number, signal);
    if (p.state !== "open" && p.state !== "draft" && p.state !== "closed" && p.state !== "merged")
      throw new ForgeError("unsupported");
    decode(comment, await this.write(`/issues/${number}/comments`, { body }, signal, dispatch));
  }
  async prMergeState(number: number, signal: AbortSignal) {
    const p = decode(pull, (await this.get(`/pulls/${number}`, signal)).body);
    if (p.number !== number) throw new ForgeError("invalid_data");
    const repo = decode(metadata, (await this.get("", signal)).body);
    const methods: MergeMethod[] = [];
    if (repo.allow_merge_commits) methods.push("merge");
    if (repo.allow_squash_merge) methods.push("squash");
    if (repo.allow_rebase) methods.push("rebase");
    return decode(ForgeMergeState, {
      headSha: p.head.sha,
      state: p.merged ? "MERGED" : p.state.toUpperCase(),
      mergeState: p.mergeable === true ? "CLEAN" : "UNKNOWN",
      reviewDecision: null,
      checksState: null,
      autoMerge: null,
      queue: null,
      methods: repo.permissions.push ? methods : [],
      canEnable: false,
      canDisable: false,
      canDequeue: false,
      blockers: [],
      raw: {},
    });
  }
  async merge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
    dispatch: WriteDispatch,
    commit?: ForgeMergeCommit,
  ) {
    decode(sha, headSha);
    const state = await this.prMergeState(number, signal);
    if (state.headSha !== headSha) throw new ForgeError("head_moved");
    if (state.state !== "OPEN" || state.mergeState !== "CLEAN" || !state.methods?.includes(method))
      throw new ForgeError("forbidden");
    if (method === "rebase" && commit) throw new ForgeError("unsupported");
    await this.write(
      `/pulls/${number}/merge`,
      {
        do: method,
        head_commit_id: headSha,
        force_merge: false,
        merge_when_checks_succeed: false,
        delete_branch_after_merge: false,
        ...(commit ? { merge_title_field: commit.title, merge_message_field: commit.message } : {}),
      },
      signal,
      dispatch,
    );
  }
}
