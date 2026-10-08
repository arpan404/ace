import type { CatalogEntry, ProviderKind } from "@ace/protocol";
/** Synthetic definitions only; names and descriptions are authored for this fixture. */
export function extensionCatalog(
  provider: ProviderKind,
  project: string,
  instance: string = provider,
): CatalogEntry[] {
  const prefix = `${instance}:${project}`;
  const source = {
    provider,
    scope: "project" as const,
    path: `/fixture/${project}/.${provider}/skills/review/SKILL.md`,
  };
  const skill: CatalogEntry = {
    id: `${prefix}:skill:review`,
    kind: "skill",
    name: "review",
    description: "Review this project's changes and conventions",
    source,
    invocation:
      provider === "codex"
        ? { type: "skill", name: "review", path: source.path }
        : provider === "opencode"
          ? { type: "skill", name: "review", path: "skill-project-review" }
          : { type: "slash", name: provider === "pi" ? "skill:review" : "review" },
  };
  const entries: CatalogEntry[] = [
    skill,
    {
      id: `${instance}:skill:writing`,
      kind: "skill",
      name: "writing",
      description: "Edit prose for clarity",
      source: {
        provider,
        scope: "global",
        path: `/fixture/home/.${provider}/skills/writing/SKILL.md`,
      },
      invocation:
        provider === "codex"
          ? { type: "skill", name: "writing", path: `/fixture/home/.codex/skills/writing/SKILL.md` }
          : { type: "slash", name: "writing" },
    },
    {
      id: `${prefix}:command:tests`,
      kind: "command",
      name: "test",
      description: "Run the project's focused tests",
      source: { provider, scope: "project" },
      invocation: { type: "slash", name: "test" },
    },
    {
      id: `${instance}:agent:reviewer`,
      kind: "agent",
      name: "reviewer",
      description: "Delegate an independent code review",
      source: { provider, scope: "global" },
      invocation: { type: "agent", name: "reviewer" },
    },
    {
      id: `${instance}:mcp:docs`,
      kind: "mcp-tool",
      name: "search-docs",
      description: "Search provider documentation",
      source: { provider, scope: "global" },
      invocation: { type: "tool", name: "search", server: "docs" },
    },
    {
      id: "ace:plugin:quality",
      kind: "plugin",
      name: "Quality tools",
      description: "Skills and tools for project maintenance",
      source: { provider: "ace", scope: "ace", plugin: "quality" },
      invocation: { type: "plugin", name: "quality" },
    },
    {
      id: `${prefix}:workflow:checks`,
      kind: "workflow",
      name: "Branch checks",
      description: "Run the project's validation automation",
      source: { provider: "ace", scope: "project" },
      invocation: { type: "action", action: "automation.run:checks" },
    },
    ...[
      ["attach", "Attach files", "Add files and images"],
      ["files", "Files and folders", "Reference workspace files"],
      ["project", "Work in a project", "Choose a project"],
      ["plan", "Plan mode", "Review a plan before editing"],
      ["goal", "Goal", "Set a goal for this thread"],
    ]
      .filter(([id]) =>
        id === "plan"
          ? ["claude", "codex"].includes(provider)
          : id === "goal"
            ? provider === "codex"
            : true,
      )
      .map(([id = "", name = "", description = ""]): CatalogEntry => ({
        id: `ace:add:${id}`,
        kind: "builtin",
        name,
        description,
        source: { provider: "ace", scope: "ace" },
        invocation: { type: "action", action: id },
      })),
  ];
  if (provider === "codex")
    entries.push({
      id: `${instance}:app:drive`,
      kind: "plugin",
      name: "Google Drive",
      description: "Find documents and files in Drive",
      icon: "https://example.invalid/drive.svg",
      source: { provider, scope: "plugin", plugin: "Google Drive" },
      invocation: { type: "mention", name: "Google Drive", path: "app://fixture-google-drive" },
    });
  if (provider === "claude")
    entries.push({
      id: `${instance}:plugin:quality:skill:fix`,
      kind: "skill",
      name: "quality:fix",
      description: "Fix issues found by the quality plugin",
      source: { provider, scope: "plugin", plugin: "quality" },
      invocation: { type: "slash", name: "quality:fix" },
    });
  return entries;
}
