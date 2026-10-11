import { ForgeError } from "@ace/forge";
import { GitError } from "@ace/git";
import type {
  HostedRepository,
  RepositoryPublication,
  RepositoryPublishInput,
  WorkspaceId,
} from "@ace/protocol";

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
    if (JSON.stringify(previous.publication.input) !== JSON.stringify(input))
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
    remote.repository.owner.toLowerCase() === input.owner.toLowerCase() &&
    remote.repository.name.toLowerCase() === input.name.toLowerCase() &&
    remote.repository.host === input.host &&
    remote.visibility === input.visibility &&
    remote.description === input.description &&
    !remote.archived &&
    !remote.fork
  );
}
export function publicationError(error: unknown): string {
  if (error instanceof GitError && error.code === "not_a_repo") return "publication_not_repository";
  if (error instanceof ForgeError) return `forge_${error.kind}`;
  if (error instanceof Error && /^publication_[a-z_]+$/.test(error.message)) return error.message;
  return "publication_failed";
}
