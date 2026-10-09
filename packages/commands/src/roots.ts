import { join } from "node:path";
import type { ProviderInstance } from "./catalog.ts";
import type { ParseContext } from "./types.ts";

export interface DiscoveryRoot {
  path: string;
  format: ParseContext["format"] | "opencode-config";
  scope: "user" | "workspace";
  instance?: string | undefined;
  skill?: boolean | undefined;
  skillLinkHome?: string | undefined;
  kind?: import("@ace/protocol").CatalogKind | undefined;
  plugin?: string | undefined;
  trustedRoot?: string | undefined;
}
export function discoveryRoots(
  instances: readonly ProviderInstance[],
  aceHome: string,
  workspace: string,
): DiscoveryRoot[] {
  const roots: DiscoveryRoot[] = [
    { path: join(aceHome, "prompts"), trustedRoot: aceHome, format: "library", scope: "user" },
    {
      path: join(workspace, ".ace/prompts"),
      trustedRoot: workspace,
      format: "library",
      scope: "workspace",
    },
  ];
  for (const scope of [
    { path: aceHome, scope: "user" as const },
    { path: join(workspace, ".ace"), scope: "workspace" as const },
  ])
    roots.push({
      path: join(scope.path, "skills"),
      trustedRoot: scope.scope === "workspace" ? workspace : aceHome,
      format: "library",
      scope: scope.scope,
      skill: true,
    });
  for (const instance of instances) {
    const scopes = [
      { path: instance.home, scope: "user" as const },
      { path: join(workspace, `.${instance.provider}`), scope: "workspace" as const },
    ];
    if (["claude", "codex", "cursor", "opencode"].includes(instance.provider))
      for (const scope of scopes) {
        for (const folder of instance.provider === "opencode" ? ["agent", "agents"] : ["agents"])
          roots.push({
            path: join(scope.path, folder),
            trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
            format:
              instance.provider === "opencode"
                ? "opencode"
                : instance.provider === "cursor"
                  ? "cursor"
                  : instance.provider === "codex"
                    ? "codex"
                    : "claude",
            scope: scope.scope,
            instance: instance.id,
            kind: "agent",
          });
      }
    if (instance.provider === "cursor" || instance.provider === "pi")
      for (const scope of scopes) {
        for (const folder of instance.provider === "pi"
          ? ["skills", "prompts"]
          : ["skills", "commands"])
          roots.push({
            path: join(scope.path, folder),
            trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
            format: instance.provider,
            scope: scope.scope,
            instance: instance.id,
            skill: folder === "skills",
            ...(scope.scope === "user" && instance.skillsHome
              ? { skillLinkHome: instance.skillsHome }
              : {}),
          });
      }
    if (instance.provider === "codex" || instance.provider === "opencode") {
      for (const scope of scopes)
        roots.push({
          path: join(scope.path, "skills"),
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          format: instance.provider,
          scope: scope.scope,
          instance: instance.id,
          skill: true,
          ...(scope.scope === "user" && instance.skillsHome
            ? { skillLinkHome: instance.skillsHome }
            : {}),
        });
      roots.push({
        path: join(workspace, ".agents/skills"),
        trustedRoot: workspace,
        format: instance.provider,
        scope: "workspace",
        instance: instance.id,
        skill: true,
      });
      if (instance.skillsHome)
        roots.push({
          path: join(instance.skillsHome, ".agents/skills"),
          trustedRoot: instance.skillsHome,
          format: instance.provider,
          scope: "user",
          instance: instance.id,
          skill: true,
          skillLinkHome: instance.skillsHome,
        });
    }
    if (instance.provider === "claude")
      for (const scope of scopes) {
        roots.push({
          path: join(scope.path, "commands"),
          scope: scope.scope,
          format: "claude",
          instance: instance.id,
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
        });
        roots.push({
          path: join(scope.path, "skills"),
          scope: scope.scope,
          format: "claude",
          instance: instance.id,
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          skill: true,
          ...(scope.scope === "user" && instance.skillsHome
            ? { skillLinkHome: instance.skillsHome }
            : {}),
        });
      }
    else if (instance.provider === "codex")
      for (const scope of scopes)
        roots.push({
          path: join(scope.path, "prompts"),
          scope: scope.scope,
          format: "codex",
          instance: instance.id,
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
        });
    else if (instance.provider === "opencode") {
      for (const scope of scopes) {
        for (const folder of ["command", "commands"])
          roots.push({
            path: join(scope.path, folder),
            scope: scope.scope,
            format: "opencode",
            instance: instance.id,
            trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          });
        for (const file of ["opencode.json", "opencode.jsonc"])
          roots.push({
            path: join(scope.scope === "workspace" ? workspace : scope.path, file),
            scope: scope.scope,
            format: "opencode-config",
            instance: instance.id,
            trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          });
      }
    }
  }
  return roots;
}
