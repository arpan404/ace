import type { FakeDaemon } from "@ace/fake-daemon";

/*
 * Skills and plugins for the phone's Skills screens: project `ace`'s own skills, personal ones
 * linked into several agents (one Claude keeps a copy of), a built-in one, and two installed
 * plugins that reach different agents. No provider CLI runs.
 */

const steps = (title: string, use: string) =>
  `# ${title}\n\n${use}\n\n## Steps\n\n1. Read the request and the files it names.\n2. Do the work in small, checked steps.\n3. Report what changed and what is left.\n`;

export function seedSkills(daemon: FakeDaemon, now: number): void {
  daemon.seedServices({
    skills: [
      {
        name: "release-desktop",
        description: "Build, sign and publish a desktop release of ace for both Mac CPUs.",
        body: steps("Release desktop", "Use when the person asks to ship a desktop build."),
        scope: "project",
        workspaceId: "ace",
        home: "claude",
        links: ["codex"],
        manual: true,
        argumentHint: "[version]",
        usage: { count: 6 },
      },
      {
        name: "bridge-budgets",
        description: "Check the phone bridge's frame and memory budgets before merging.",
        body: steps("Bridge budgets", "Use before merging a change to apps/ios/bridge."),
        scope: "project",
        workspaceId: "ace",
      },
      {
        name: "research",
        description: "Investigate a question against primary sources and save the findings.",
        body: steps("Research", "Use when the person wants a topic researched."),
        scope: "personal",
        links: ["claude"],
        usage: { count: 14 },
      },
      {
        name: "unslop",
        description: "Cut AI tells from any writing.",
        body: steps("Unslop", "Apply to every piece of prose before it ships."),
        scope: "personal",
        links: ["claude"],
        usage: { count: 31 },
      },
      {
        name: "cloudflare",
        description: "Cloudflare platform skill covering Workers, Pages and storage.",
        body: steps("Cloudflare", "Prefer retrieval from Cloudflare docs."),
        scope: "personal",
        home: "claude",
        copies: ["codex"],
      },
      {
        name: "review-changes",
        description: "Review the changes in this worktree before they are committed or merged.",
        body: steps("Review changes", "Read the diff, then the files around it."),
        scope: "builtin",
      },
    ],
    plugins: {
      installed: [
        {
          name: "engineering",
          version: "2.3.0",
          acceptedAt: now - 12 * 86_400_000,
          executions: [],
          providers: ["claude", "codex", "cursor"],
          components: [
            {
              name: "code-review",
              kind: "skill",
              path: "skills/code-review/SKILL.md",
              description: "Review a diff against repo standards and the spec.",
              text: "# Code review\n\nReview the changes along two axes: standards and spec.\n",
            },
            {
              name: "pr-desc",
              title: "Pull request description",
              kind: "command",
              path: "commands/pr-desc.md",
              description: "Write a pull request description from the branch's commits.",
              text: "# Pull request description\n\nSummarise the commits as a PR body.\n",
            },
          ],
        },
        {
          name: "sentry",
          version: "0.4.1",
          acceptedAt: now - 3 * 86_400_000,
          executions: [],
          enabled: false,
          components: [
            {
              name: "triage-issue",
              kind: "skill",
              path: "skills/triage-issue/SKILL.md",
              description: "Triage a Sentry issue: reproduce, find the commit, propose a fix.",
              text: "# Triage issue\n\nReproduce first.\n",
            },
          ],
        },
      ],
    },
  });
}
