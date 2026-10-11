import { ForgeError, repositoryKey } from "@ace/forge";
import { GitError } from "@ace/git";
import type {
  HostedRepository,
  RepositoryPublication,
  RepositoryPublishInput,
  WorkspaceId,
} from "@ace/protocol";

function intentKey(input: RepositoryPublishInput): string {
  const { host, owner, name, ...options } = input;
  return JSON.stringify([repositoryKey({ forge: "github", host, owner, name }), options]);
}

export type PublicationRecord = { device: string; publication: RepositoryPublication };
/** Only an intent that never dispatched creation can be edited. */
export function publicationIntent(
  previous: PublicationRecord | null,
  device: string,
  input: RepositoryPublishInput,
  workspaceId: WorkspaceId,
  updatedAt: number,
): RepositoryPublication {
  if (previous?.device !== undefined && previous.device !== device)
    throw new Error("publication_intent_mismatch");
  if (previous && previous.publication.phase !== "prepared") {
    if (intentKey(previous.publication.input) !== intentKey(input))
      throw new Error("publication_intent_mismatch");
    return previous.publication;
  }
  return { workspaceId, input, phase: "prepared", remote: null, error: null, updatedAt };
}
export function publicationRemoteMatches(
  input: RepositoryPublishInput,
  remote: HostedRepository,
): boolean {
  return (
    repositoryKey(remote.repository) ===
      repositoryKey({ forge: "github", host: input.host, owner: input.owner, name: input.name }) &&
    remote.visibility === input.visibility &&
    remote.description === input.description &&
    !remote.archived &&
    !remote.fork
  );
}
export function publicationError(error: unknown): string {
  if (error instanceof GitError && error.code === "sensitive_publication") return "publication_sensitive_history";
  if (error instanceof GitError && error.code === "publication_scan_incomplete") return "publication_scan_incomplete";
  if (error instanceof GitError && error.code === "not_a_repo") return "publication_not_repository";
  if (error instanceof ForgeError) return `forge_${error.kind}`;
  if (error instanceof Error && /^publication_[a-z_]+$/.test(error.message)) return error.message;
  return "publication_failed";
}
