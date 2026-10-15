import { z } from "zod";
import { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";

const branch = z.string().min(1).max(256);
const summary = z.looseObject({
  name: z.string().min(1).max(100),
  owner: z.looseObject({ login: z.string().min(1).max(100) }),
  default_branch: branch,
});
const record = summary.extend({ parent: summary.nullish() });

/** What the host says about a repository: its default branch and, for a fork, its parent. */
export type ForgeRepositoryMetadata = {
  repository: ForgeRepository;
  defaultBranch: string;
  /** The repository this one was forked from, which is where its PRs belong. */
  parent: { repository: ForgeRepository; defaultBranch: string } | null;
};

export async function githubRepositoryMetadata(
  api: GhApi,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<ForgeRepositoryMetadata> {
  const response = await api.request(`repos/${repository.owner}/${repository.name}`, signal);
  const parsed = record.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const locate = (value: z.infer<typeof summary>) => {
    const located = ForgeRepository.safeParse({
      ...repository,
      owner: value.owner.login,
      name: value.name,
    });
    if (!located.success) throw new ForgeError("invalid_data");
    return located.data;
  };
  const parent = parsed.data.parent;
  return {
    repository: locate(parsed.data),
    defaultBranch: parsed.data.default_branch,
    parent: parent ? { repository: locate(parent), defaultBranch: parent.default_branch } : null,
  };
}
