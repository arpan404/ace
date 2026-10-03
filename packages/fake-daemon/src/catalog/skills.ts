/** A skill, plugin or slash command as the fake catalog serves it. */
export interface FakeSkill {
  id: string;
  kind: "skill" | "plugin" | "command";
  name: string;
  description: string;
  source: "repo" | "user" | "plugin";
  /** Where it was loaded from, e.g. "repo · .claude/skills". */
  location: string;
  /** The file that defines it, on the daemon's machine. */
  sourcePath?: string | undefined;
  usage: string;
  availability: string;
  enabled: boolean;
  preview: string;
}

const everyProvider =
  "Every provider that supports skills. Codex and OpenCode load it as a prompt.";

/** The Skills view in the approved design: four skills, two plugins, two slash commands. */
export function skillCatalog(): FakeSkill[] {
  return [
    {
      id: "code-review",
      kind: "skill",
      name: "code-review",
      description: "Review a diff against repo standards and the spec",
      source: "repo",
      location: "repo · .claude/skills",
      sourcePath: "/Users/dev/ace/.claude/skills/code-review/SKILL.md",
      usage: "12 threads this week",
      availability: everyProvider,
      enabled: true,
      preview:
        "# code-review\n\nReview the changes since a fixed point along two axes:\nstandards (repo conventions) and spec (what the issue asked for).\nRun both reviews in parallel and report them side by side.",
    },
    {
      id: "tdd",
      kind: "skill",
      name: "tdd",
      description: "Red, green, refactor with integration tests",
      source: "repo",
      location: "repo · .claude/skills",
      sourcePath: "/Users/dev/ace/.claude/skills/tdd/SKILL.md",
      usage: "5 threads",
      availability: everyProvider,
      enabled: true,
      preview:
        "# tdd\n\nWrite one failing behaviour test, make it pass with the smallest change,\nthen refactor with the suite green. Prefer real edges over mocks.",
    },
    {
      id: "diagnosing-bugs",
      kind: "skill",
      name: "diagnosing-bugs",
      description: "Diagnosis loop for hard bugs and regressions",
      source: "user",
      location: "user · ~/.claude/skills",
      sourcePath: "/Users/dev/.claude/skills/diagnosing-bugs/SKILL.md",
      usage: "3 threads",
      availability: everyProvider,
      enabled: true,
      preview:
        "# diagnosing-bugs\n\nReproduce first. Bisect the change, form one hypothesis at a time,\nand write the regression test before the fix.",
    },
    {
      id: "release-notes",
      kind: "skill",
      name: "release-notes",
      description: "Draft notes from merged PRs since the last tag",
      source: "user",
      location: "user · ~/.claude/skills",
      sourcePath: "/Users/dev/.claude/skills/release-notes/SKILL.md",
      usage: "1 thread",
      availability: "Claude Code only.",
      enabled: false,
      preview:
        "# release-notes\n\nList merged PRs since the last tag, group them by area,\nand write one plain sentence per user-visible change.",
    },
    {
      id: "github",
      kind: "plugin",
      name: "GitHub",
      description: "PRs, checks and review comments",
      source: "plugin",
      location: "Codex plugin · github@1.4.2",
      sourcePath: "/Users/dev/.ace/plugins/github/plugin.json",
      usage: "Connected",
      availability: "Codex and Claude Code.",
      enabled: true,
      preview:
        "GitHub plugin\n\nTools: list_pull_requests, get_checks, post_review_comment\nAuth: GitHub app (installed on arpan404)",
    },
    {
      id: "sentry",
      kind: "plugin",
      name: "Sentry",
      description: "Pull issues and stack traces into a thread",
      source: "plugin",
      location: "ACP plugin · sentry@0.9.0",
      sourcePath: "/Users/dev/.ace/plugins/sentry/plugin.json",
      usage: "Connected",
      availability: "Every provider through MCP.",
      enabled: true,
      preview:
        "Sentry plugin\n\nTools: get_issue, list_events, resolve_issue\nAuth: Sentry token in the Sentry CLI's own config",
    },
    {
      id: "standup",
      kind: "command",
      name: "/standup",
      description: "Summarise what moved in the last 24h",
      source: "repo",
      location: "repo prompt · .ace/commands/standup.md",
      sourcePath: "/Users/dev/ace/.ace/commands/standup.md",
      usage: "Daily",
      availability: "Every provider, as a prompt.",
      enabled: true,
      preview:
        "/standup\n\nSummarise what moved in the last 24 hours across my threads.\nGroup by project. Lead with anything that needs me.",
    },
    {
      id: "pr-desc",
      kind: "command",
      name: "/pr-desc",
      description: "Write the PR description from the diff",
      source: "repo",
      location: "repo prompt · .ace/commands/pr-desc.md",
      sourcePath: "/Users/dev/ace/.ace/commands/pr-desc.md",
      usage: "8 uses",
      availability: "Every provider, as a prompt.",
      enabled: true,
      preview:
        "/pr-desc $base\n\nRead the diff against $base and write a PR description:\nwhat changed, why, and how it was tested.",
    },
  ];
}
