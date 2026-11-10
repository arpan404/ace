import type { ClientCore } from "@ace/client";
import {
  configuredForges,
  ForgeRepository,
  ProjectRepositories,
  SourceControlPreferences,
  WorkspaceActionRequest,
  WorkspaceId,
  type ProjectRepositoryConfig,
} from "@ace/protocol";
import {
  addRepository,
  hideRepository,
  makePrimary,
  removeRepository,
  repositoryFromAddress,
  repositoryLabel,
  repositoryLine,
  repositoryRefusalText,
  sameRepository,
  showRepository,
} from "@ace/ui-core";
import { z } from "zod";
import type { WriteOutcome } from "./project-manage.ts";

/*
 * A project's repositories in its settings on the phone (ADR 0116): each repository the daemon
 * lists with where it comes from, and the person's choices (primary, hidden, added by hand).
 * Every change reads the saved choices afresh, applies one shared edit and saves the whole
 * choice through the durable outbox, so a change made elsewhere meanwhile is kept. Swift draws.
 */

export const RepositorySettingsRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("repositories.read"), workspaceId: WorkspaceId }),
  z.object({
    op: z.literal("repositories.change"),
    workspaceId: WorkspaceId,
    change: z.enum(["primary", "hide", "show", "remove"]),
    repository: ForgeRepository,
  }),
  z.object({
    op: z.literal("repositories.add"),
    workspaceId: WorkspaceId,
    address: z.string().max(4_096),
  }),
]);
export type RepositorySettingsRequest = z.infer<typeof RepositorySettingsRequest>;

export type RepositorySettingsOwner = Pick<ClientCore, "request">;
type Write = (raw: unknown, words: (code: string) => string | undefined) => Promise<WriteOutcome>;

const quiet = { timeoutMs: 15_000 };
const unreachable = "Couldn't read the project's repositories. Check the connection and try again.";

/** What Swift draws for the project's repositories. Pure. */
export function repositorySettingsView(value: ProjectRepositories) {
  return {
    ok: true as const,
    rows: value.repositories.map((entry) => ({
      id: `${entry.repository.forge}@${entry.repository.host}/${entry.repository.owner}/${entry.repository.name}`,
      repository: entry.repository,
      forge: entry.repository.forge,
      label: repositoryLabel(entry.repository),
      line: repositoryLine(entry),
      primary: entry.primary,
      visible: entry.visible,
      available: entry.available,
      canMakePrimary: !entry.primary && entry.available,
      canHide: entry.visible,
      canShow: !entry.visible,
      canRemove: entry.source === "manual",
    })),
  };
}

const refused = (message: string) => ({ ok: false as const, code: "invalid", message });

export class RepositorySettings {
  readonly #owner: RepositorySettingsOwner;
  readonly #write: Write;
  constructor(owner: RepositorySettingsOwner, write: Write) {
    this.#owner = owner;
    this.#write = write;
  }

  async answer(request: RepositorySettingsRequest): Promise<unknown> {
    if (request.op === "repositories.read") {
      const value = await this.#read(request.workspaceId).catch(() => undefined);
      return value ? repositorySettingsView(value) : { ok: false, message: unreachable };
    }
    const current = await this.#read(request.workspaceId).catch(() => undefined);
    if (!current) return refused(unreachable);
    if (request.op === "repositories.add") return this.#add(current, request.address);
    const edit = {
      primary: makePrimary,
      hide: hideRepository,
      show: showRepository,
      remove: removeRepository,
    }[request.change];
    return this.#save(current.workspaceId, edit(current.config, request.repository));
  }

  async #add(current: ProjectRepositories, address: string): Promise<unknown> {
    const hosts = await this.#hosts().catch(() => undefined);
    if (!hosts) return refused("Couldn't read your Git hosts. Try again.");
    const parsed = repositoryFromAddress(address, hosts);
    if (!parsed.ok) return refused(parsed.problem);
    const listed = current.repositories.find((entry) =>
      sameRepository(entry.repository, parsed.repository),
    );
    if (listed?.visible)
      return refused(`${repositoryLabel(parsed.repository)} is already in this project.`);
    return this.#save(current.workspaceId, addRepository(current.config, parsed.repository));
  }

  #save(workspaceId: WorkspaceId, repositories: ProjectRepositoryConfig | null) {
    return this.#write(
      { type: "workspace.repositories.set", workspaceId, repositories },
      repositoryRefusalText,
    );
  }

  async #read(workspaceId: WorkspaceId): Promise<ProjectRepositories | undefined> {
    const request = WorkspaceActionRequest.parse({
      type: "workspace.request",
      requestId: "project-repositories",
      operation: { op: "forge.repositories", workspaceId },
    });
    const reply = await this.#owner.request(request, quiet);
    const result = reply.result;
    if (result.kind !== "forge" || result.data.resource !== "repositories") return undefined;
    return ProjectRepositories.parse(result.data.value);
  }

  /** The configured hosts' providers, as source control settings save them. */
  async #hosts() {
    const read = await this.#owner.request(
      { type: "settings.get", key: "sourceControl.preferences", scope: {} },
      quiet,
    );
    const entry = read.entries.find((item) => item.key === "sourceControl.preferences");
    const preferences = SourceControlPreferences.safeParse(entry?.value);
    return preferences.success ? configuredForges(preferences.data.hosts) : {};
  }
}
