import { forgeCapabilities } from "@ace/forge";
import type { ForgeCapability, ForgeRepository } from "@ace/protocol";
import {
  normalizeRepositoryConfig,
  resolveProjectRepositories,
  sameRepositoryConfig,
  type CheckoutRemote,
} from "@ace/forge/project-repositories";
import {
  ProjectRepositoryConfig,
  WorkspaceId,
  type ProjectRepositories,
  type SourceControlPreferences,
} from "@ace/protocol";

/** The fake host settings: GitHub and GitLab, as a person with a mirror would have. */
const preferences: SourceControlPreferences = {
  hosts: [{ host: "github.com" }, { host: "gitlab.com" }],
  host: "github.com",
  remote: "origin",
};

/**
 * Fake projects' repository choices (ADR 0116), resolved by the daemon's own rule. Every
 * project has a GitHub `origin` (`acme/<id>`, the repository `forge.repository` has always
 * answered); a project given a GitLab mirror (`addMirror`, as `seedGitLabMirror` does for
 * `ace`) also has a `mirror` remote on gitlab.com, for multi-host UI.
 */
export class FakeProjectRepositories {
  private configs = new Map<string, ProjectRepositoryConfig>();
  private mirrored = new Map<string, readonly ForgeCapability[]>();
  /** Give the project a `mirror` remote: `acme/<id>` on gitlab.com. */
  addMirror(workspaceId: string, extraCapabilities: readonly ForgeCapability[] = []): void {
    this.mirrored.set(workspaceId, extraCapabilities);
  }
  capabilities(repository: ForgeRepository): ForgeCapability[] {
    const extra =
      repository.forge === "gitlab" &&
      repository.host === "gitlab.com" &&
      repository.owner === "acme"
        ? (this.mirrored.get(repository.name) ?? [])
        : [];
    return [...new Set([...forgeCapabilities[repository.forge], ...extra])];
  }
  private remotes(workspaceId: string): CheckoutRemote[] {
    const origin = { name: "origin", fetchUrls: [`https://github.com/acme/${workspaceId}.git`] };
    if (!this.mirrored.has(workspaceId)) return [origin];
    return [origin, { name: "mirror", fetchUrls: [`git@gitlab.com:acme/${workspaceId}.git`] }];
  }
  read(workspaceId: string): ProjectRepositories {
    const config = this.configs.get(workspaceId);
    const resolved = resolveProjectRepositories({
      remotes: this.remotes(workspaceId),
      preferences,
      config,
    });
    return {
      workspaceId: WorkspaceId.parse(workspaceId),
      repositories: resolved.repositories.map((entry) => ({
        ...entry,
        capabilities: this.capabilities(entry.repository),
      })),
      primary: resolved.primary?.repository ?? null,
      config: config ?? null,
    };
  }
  /** Save choices as the daemon does; an error code when it would refuse them. */
  set(
    workspaceId: string,
    input: ProjectRepositoryConfig | null,
    expected?: ProjectRepositoryConfig | null,
  ): string | undefined {
    if (expected !== undefined && !sameRepositoryConfig(this.configs.get(workspaceId), expected))
      return "repositories_changed";
    const normalized = normalizeRepositoryConfig(input && ProjectRepositoryConfig.parse(input));
    if (!normalized.ok) return normalized.error;
    if (normalized.config) this.configs.set(workspaceId, normalized.config);
    else this.configs.delete(workspaceId);
    return undefined;
  }
}
