import { GitLabApi } from "./gitlab-api.ts";
import { GitLabReader } from "./gitlab-reader.ts";
import { GitLabMergeState } from "./gitlab-merge-state.ts";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { CommandRunner } from "./command.ts";

/** Structural merge backend for the shared durable PR action journal. The runner must come
 * from SourceControl.writeIdentity with gitlabMergeWrites, never a raw CLI runner. */
export class GitLabHostedMerge {
  readonly #reader: GitLabReader;
  readonly #merge: GitLabMergeState;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.#reader = new GitLabReader(options);
    this.#merge = new GitLabMergeState(new GitLabApi(options));
  }
  status(...args: Parameters<GitLabReader["status"]>) {
    return this.#reader.status(...args);
  }
  prMergeState(...args: Parameters<GitLabMergeState["read"]>) {
    return this.#merge.read(...args);
  }
  merge(...args: Parameters<GitLabMergeState["merge"]>) {
    return this.#merge.merge(...args);
  }
  changeMergeState(...args: Parameters<GitLabMergeState["change"]>) {
    return this.#merge.change(...args);
  }
}
