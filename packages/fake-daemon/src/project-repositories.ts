import {
  normalizeRepositoryConfig,
  resolveProjectRepositories,
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
 * Each fake project's remotes. Every project has a GitHub `origin` (`acme/<id>`, the repository
 * `forge.repository` has always answered); `ace` also has a GitLab mirror, for multi-host UI.
 */
function remotes(workspaceId: string): CheckoutRemote[] {
  const origin = { name: "origin", fetchUrls: [`https://github.com/acme/${workspaceId}.git`] };
  return workspaceId === "ace"
    ? [origin, { name: "mirror", fetchUrls: ["git@gitlab.com:acme/ace.git"] }]
    : [origin];
}

/** Fake projects' repository choices (ADR 0116), resolved by the daemon's own rule. */
export class FakeProjectRepositories {
  private configs = new Map<string, ProjectRepositoryConfig>();
  read(workspaceId: string): ProjectRepositories {
    const config = this.configs.get(workspaceId);
    const resolved = resolveProjectRepositories({
      remotes: remotes(workspaceId),
      preferences,
      config,
    });
    return {
      workspaceId: WorkspaceId.parse(workspaceId),
      repositories: resolved.repositories,
      primary: resolved.primary?.repository ?? null,
      config: config ?? null,
    };
  }
  /** Save choices as the daemon does; an error code when it would refuse them. */
  set(workspaceId: string, input: ProjectRepositoryConfig | null): string | undefined {
    const normalized = normalizeRepositoryConfig(input && ProjectRepositoryConfig.parse(input));
    if (!normalized.ok) return normalized.error;
    if (normalized.config) this.configs.set(workspaceId, normalized.config);
    else this.configs.delete(workspaceId);
    return undefined;
  }
}
