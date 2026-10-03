import type { PluginSeed } from "../plugins-wire.ts";

const day = 86_400_000;

/**
 * The Skills view in the approved design, as the plugin service serves it: two plugins with
 * skills and slash commands installed and reviewed earlier, and one more the marketplace offers
 * (its review shows the MCP server it would run).
 */
export function pluginCatalog(now: number): PluginSeed {
  return {
    installed: [
      {
        name: "engineering",
        version: "2.3.0",
        acceptedAt: Math.max(0, now - 12 * day),
        executions: [],
        components: [
          {
            name: "code-review",
            kind: "skill",
            path: "skills/code-review/SKILL.md",
            description: "Review a diff against repo standards and the spec",
            text: "# code-review\n\nReview the changes since a fixed point along two axes:\nstandards (repo conventions) and spec (what the issue asked for).\nRun both reviews in parallel and report them side by side.\n",
          },
          {
            name: "tdd",
            kind: "skill",
            path: "skills/tdd/SKILL.md",
            description: "Red, green, refactor with integration tests",
            text: "# tdd\n\nWrite one failing behaviour test, make it pass with the smallest change,\nthen refactor with the suite green. Prefer real edges over mocks.\n",
          },
          {
            name: "diagnosing-bugs",
            kind: "skill",
            path: "skills/diagnosing-bugs/SKILL.md",
            description: "Diagnosis loop for hard bugs and regressions",
            text: "# diagnosing-bugs\n\nReproduce first. Bisect the change, form one hypothesis at a time,\nand write the regression test before the fix.\n",
          },
          {
            name: "pr-desc",
            kind: "command",
            path: "commands/pr-desc.md",
            description: "Write the PR description from the diff",
            text: "/pr-desc $base\n\nRead the diff against $base and write a PR description:\nwhat changed, why, and how it was tested.\n",
          },
          {
            name: "reviewer",
            kind: "agent",
            path: "agents/reviewer.md",
            description: "An adversarial reviewer that tries to break the change",
            text: "# reviewer\n\nYou review changes adversarially. Try to break them: write the probe,\nrun it, and report what failed with evidence.\n",
          },
        ],
      },
      {
        name: "release",
        version: "0.4.1",
        acceptedAt: Math.max(0, now - 30 * day),
        enabled: false,
        providers: ["claude"],
        executions: [],
        components: [
          {
            name: "release-notes",
            kind: "skill",
            path: "skills/release-notes/SKILL.md",
            description: "Draft notes from merged PRs since the last tag",
            text: "# release-notes\n\nList merged PRs since the last tag, group them by area,\nand write one plain sentence per user-visible change.\n",
          },
          {
            name: "standup",
            kind: "command",
            path: "commands/standup.md",
            description: "Summarise what moved in the last 24h",
            text: "/standup\n\nSummarise what moved in the last 24 hours across my threads.\nGroup by project. Lead with anything that needs me.\n",
          },
        ],
      },
    ],
    marketplace: [
      {
        name: "sentry",
        version: "0.9.0",
        executions: [
          {
            kind: "stdio",
            name: "sentry",
            command: "npx",
            args: ["-y", "@sentry/mcp-server@0.9.0"],
            env: {},
          },
        ],
        components: [
          {
            name: "triage-issue",
            kind: "skill",
            path: "skills/triage-issue/SKILL.md",
            description: "Pull a Sentry issue and its stack trace into the thread",
            text: "# triage-issue\n\nFetch the issue, its latest event and stack trace, and find the\nfirst frame in this repository before proposing a fix.\n",
          },
        ],
      },
    ],
  };
}
