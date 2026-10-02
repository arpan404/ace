import { join } from "node:path";
import type { ProviderInstance } from "./catalog.ts";
import type { ParseContext } from "./types.ts";

export interface DiscoveryRoot {
  path: string;
  format: ParseContext["format"] | "opencode-config";
  scope: "user" | "workspace";
  instance?: string | undefined;
  skill?: boolean | undefined;
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
  for (const instance of instances) {
    const scopes = [
      { path: instance.home, scope: "user" as const },
      { path: join(workspace, `.${instance.provider}`), scope: "workspace" as const },
    ];
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
