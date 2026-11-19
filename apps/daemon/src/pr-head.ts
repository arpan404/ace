import {
  ForgeError,
  repositoryKey,
  repositoryWriteRefusal,
  type ForgeRepositoryMetadata,
  type ResolvedProjectRepositories,
} from "@ace/forge";
import type { ProjectRepository } from "@ace/protocol";

/** Where a new pull request's branch is pushed (ADR 0120): a listed repository and its remote. */
export interface PrHead {
  /** The repository the branch is pushed to, as the project lists it. */
  pushed: ProjectRepository;
  /** The remote that names `pushed`; none for a primary only added by hand. */
  remote: string | undefined;
  /** What the host says about `pushed`, when deciding needed it. */
  metadata?: ForgeRepositoryMetadata | undefined;
}

type ReadMetadata = (entry: ProjectRepository) => Promise<ForgeRepositoryMetadata>;

const same = (a: ProjectRepository, b: ProjectRepository) =>
  repositoryKey(a.repository) === repositoryKey(b.repository);

/**
 * The push before a new PR, and so where the PR's branch lives:
 *
 * - The global remote name's repository when it is the primary, or a fork of the primary: the
 *   fork workflow pushes to the fork and opens the PR on the primary from `fork-owner:branch`.
 * - Else the primary's own remote.
 *
 * Without saved choices the primary is the global remote name's repository, so nothing is read
 * from the host. With choices, the global remote name's repository's metadata is read when it
 * isn't the primary, to see whether it is the primary's fork.
 */
export async function resolvePrHead(input: {
  resolved: ResolvedProjectRepositories;
  /** The global source control remote name (`origin` by default). */
  globalRemote: string;
  metadata: ReadMetadata;
}): Promise<PrHead> {
  const { resolved, globalRemote } = input;
  const primary = resolved.primary;
  if (!primary) throw new ForgeError("unsupported");
  const own = resolved.repositories.find(
    (entry) => entry.remote === globalRemote && entry.visible && entry.available,
  );
  if (own && !same(own, primary)) {
    const metadata = await input.metadata(own);
    const parent = metadata.parent?.repository;
    if (parent && repositoryKey(parent) === repositoryKey(primary.repository))
      return { pushed: own, remote: globalRemote, metadata };
  }
  return { pushed: primary, remote: primary.remote };
}

/**
 * The pushed repository's metadata as a new PR uses it: its `parent` is where the PR opens. A
 * parent the project lists hidden or unavailable is cleared, so hiding a fork's parent keeps
 * the project's new pull requests in the fork itself.
 */
export async function prHeadMetadata(
  head: PrHead,
  resolved: ResolvedProjectRepositories,
  read: ReadMetadata,
): Promise<ForgeRepositoryMetadata> {
  const metadata = head.metadata ?? (await read(head.pushed));
  const parent = metadata.parent;
  if (parent && repositoryWriteRefusal(resolved, parent.repository))
    return { ...metadata, parent: null };
  return metadata;
}
