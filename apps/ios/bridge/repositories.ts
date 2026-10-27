import type { ClientCore } from "@ace/client";
import {
  RepositoryListInput,
  RepositoryPublishInput,
  WorkspaceId,
  type RepositoryPublication,
  type SourceControlReadiness,
} from "@ace/protocol";
import { publicationProblem } from "@ace/ui-core";
import { z } from "zod";
import type { WriteOutcome } from "./project-manage.ts";

/*
 * GitHub through the machine's own gh login (ADR 0002), as the web's Add project › GitHub and
 * Publish repository: list the account's repositories to clone, and publish a project that has
 * no origin yet as a new hosted repository, then follow the durable publication record. ace
 * never holds a GitHub credential; the machine's CLI does every call.
 */

const quiet = { timeoutMs: 20_000 };

export const RepositoryRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("repos.context") }),
  z.object({
    op: z.literal("repos.list"),
    host: z.string().max(256),
    account: z.string().max(256),
    owner: z.string().max(256).optional(),
    query: z.string().max(256).default(""),
    visibility: z.enum(["all", "public", "private"]).default("all"),
    archived: z.enum(["all", "yes", "no"]).default("no"),
    fork: z.enum(["all", "yes", "no"]).default("all"),
  }),
  z.object({
    op: z.literal("publish.status"),
    workspaceId: WorkspaceId,
    name: z.string().max(256),
  }),
  z.object({ op: z.literal("publish"), workspaceId: WorkspaceId, input: z.unknown() }),
  z.object({ op: z.literal("publish.cancel"), workspaceId: WorkspaceId }),
]);
export type RepositoryRequest = z.infer<typeof RepositoryRequest>;

export type RepositoriesOwner = Pick<ClientCore, "request">;

/** The machine's gh readiness, as the pickers need it. */
function context(readiness: SourceControlReadiness) {
  return {
    ready: readiness.api === "ready",
    instructions: readiness.api === "ready" ? null : readiness.instructions,
    hosts: readiness.preferences.hosts.map((entry) => entry.host),
    host: readiness.preferences.host,
    account: readiness.account ?? "",
    accounts: readiness.accounts.map((entry) => entry.login),
  };
}

const phaseWords: Record<RepositoryPublication["phase"], string> = {
  prepared: "Ready to publish",
  creating: "Creating the repository…",
  remote_created: "Repository created",
  origin_added: "Origin added",
  empty: "Published. The project has no commits to push yet.",
  pushed: "Published, and the current branch pushed.",
};

function publicationRow(publication: RepositoryPublication | null) {
  if (!publication) return null;
  return {
    phase: publication.phase,
    words: phaseWords[publication.phase],
    url: publication.remote?.url ?? null,
    fullName: publication.remote
      ? `${publication.remote.repository.owner}/${publication.remote.repository.name}`
      : null,
    problem: publication.error ? publicationProblem(publication.error) : null,
  };
}

export class Repositories {
  readonly #owner: RepositoriesOwner;
  readonly #write: (raw: unknown) => Promise<WriteOutcome>;
  constructor(owner: RepositoriesOwner, write: (raw: unknown) => Promise<WriteOutcome>) {
    this.#owner = owner;
    this.#write = write;
  }

  async answer(request: RepositoryRequest): Promise<unknown> {
    try {
      switch (request.op) {
        case "repos.context":
          return { ok: true, ...context(await this.#readiness()) };
        case "repos.list": {
          const input = RepositoryListInput.safeParse({
            host: request.host,
            account: request.account,
            ...(request.owner?.trim() ? { owner: request.owner.trim() } : {}),
            query: request.query,
            visibility: request.visibility,
            archived: request.archived,
            fork: request.fork,
          });
          if (!input.success)
            return { ok: false, message: "Enter a valid host, account and optional owner." };
          const reply = await this.#owner.request(
            { type: "repositories.request", operation: { op: "list", input: input.data } },
            quiet,
          );
          const result = reply.result;
          if (result.kind !== "repositories")
            return {
              ok: false,
              message: "Couldn't list repositories. Check the machine's GitHub CLI sign-in.",
            };
          return {
            ok: true,
            repositories: result.repositories.slice(0, 500).map((row) => ({
              id: row.id,
              fullName: `${row.repository.owner}/${row.repository.name}`,
              name: row.repository.name,
              description: row.description.slice(0, 512),
              private: row.visibility === "private",
              archived: row.archived,
              fork: row.fork,
              cloneUrl: row.cloneUrl,
            })),
          };
        }
        case "publish.status":
          return await this.#status(request.workspaceId, request.name);
        case "publish": {
          const input = RepositoryPublishInput.safeParse(request.input);
          if (!input.success)
            return {
              ok: false,
              message:
                "Enter a valid host, account, owner and repository name (up to 100 characters), and a description up to 350 characters.",
            };
          const outcome = await this.#write({
            type: "workspace.publish",
            workspaceId: request.workspaceId,
            input: input.data,
          });
          const status = await this.#status(request.workspaceId, input.data.name).catch(
            () => undefined,
          );
          return {
            ...status,
            ok: outcome.ok,
            ...(outcome.ok ? {} : { message: publicationProblem(outcome.code) }),
          };
        }
        case "publish.cancel": {
          const reply = await this.#owner.request(
            {
              type: "repositories.request",
              operation: { op: "publication.cancel", workspaceId: request.workspaceId },
            },
            quiet,
          );
          return reply.result.kind === "error"
            ? { ok: false, message: "Couldn't stop publication. Refresh to see its result." }
            : { ok: true };
        }
      }
    } catch {
      return { ok: false, message: "Couldn't reach the machine. Try again." };
    }
  }

  async #readiness(): Promise<SourceControlReadiness> {
    const reply = await this.#owner.request(
      { type: "source-control.request", operation: { op: "readiness" } },
      quiet,
    );
    if (reply.result.kind !== "readiness") throw new Error("unavailable");
    return reply.result.readiness;
  }

  /** Readiness, the durable publication record, and the form's starting values. */
  async #status(workspaceId: WorkspaceId, name: string) {
    const [readiness, record] = await Promise.all([
      this.#readiness(),
      this.#owner.request(
        { type: "repositories.request", operation: { op: "publication", workspaceId } },
        quiet,
      ),
    ]);
    if (record.result.kind !== "publication") throw new Error("unavailable");
    const publication = record.result.publication;
    return {
      ok: true,
      ...context(readiness),
      draft: publication?.input ?? {
        host: readiness.preferences.host,
        account: readiness.account ?? "",
        owner: readiness.account ?? "",
        name,
        description: "",
        visibility: "private",
      },
      // Once creation began, the record decides the repository; the form only resumes it.
      locked: publication !== null && publication.phase !== "prepared",
      publication: publicationRow(publication),
      running: record.result.running,
      canStop: record.result.canStop,
    };
  }
}
