import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { ForgePrFiles } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import { prHasCommit } from "./github-commits.ts";
import { FileRecord } from "./github-browser-schemas.ts";
import type { GhApi } from "./http.ts";
import { restFiles } from "./rest-records.ts";

/*
 * What changed between two commits of a pull request: after `since`, through `commit`, as
 * GitHub's comparison of the two lists it. Both must be commits of the PR, so a URL can never
 * name an unrelated repository commit. GitHub lists a comparison's files whole on its first
 * page (at most 300), so they are cut into the 25-file pages every file list uses.
 */

/** The most files GitHub lists for a comparison. */
const comparedFiles = 300;
const pageSize = 25;

const Comparison = z.looseObject({
  files: z.array(FileRecord).max(comparedFiles).optional(),
});

export async function rangeFiles(
  api: GhApi,
  repository: ForgeRepository,
  input: { number: number; page: number; headSha: string; commit: string; since: string },
  signal: AbortSignal,
): Promise<ForgePrFiles> {
  if (input.page > comparedFiles / pageSize) throw new ForgeError("not_found");
  const member = (sha: string) =>
    prHasCommit(api, repository, { number: input.number, headSha: input.headSha, sha }, signal);
  const [to, from] = await Promise.all([member(input.commit), member(input.since)]);
  if (!to || !from) throw new ForgeError("not_found");
  const root = `repos/${repository.owner}/${repository.name}`;
  // One commit per page: the files are what is read, and they come whole on page one.
  const response = await api.request(
    `${root}/compare/${input.since}...${input.commit}?per_page=1`,
    signal,
  );
  const parsed = Comparison.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const all = parsed.data.files ?? [];
  const records = all.slice((input.page - 1) * pageSize, input.page * pageSize);
  const more = input.page * pageSize < all.length;
  return {
    ref: { repository, number: input.number },
    baseSha: input.since,
    headSha: input.commit,
    commit: input.commit,
    since: input.since,
    files: restFiles(records),
    ...(more ? { nextPage: input.page + 1 } : {}),
    // GitHub stops listing at 300 files; a comparison that fills them may have more.
    truncated: !more && all.length >= comparedFiles,
  };
}
