import type { FakeDaemon, SkillSeed } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";

const day = 86_400_000;
const body = (title: string, intro: string) =>
  `# ${title}\n\n${intro}\n\n## Steps\n\n1. Read the request and the files it names.\n2. Do the work in small, checked steps.\n3. Report what changed and what is left.\n`;

/** The skills library of the dev world: the ace project's own skills beside personal ones. */
export function seedFakeSkills(daemon: FakeDaemon, now: number) {
  const seeds: SkillSeed[] = [
    {
      name: "release-desktop",
      description:
        "Build, sign and publish a desktop release of ace for both Mac CPUs, then update the release notes and the download page.",
      body: body("Release desktop", "Use when the person asks to ship a desktop build."),
      scope: "project",
      workspaceId: "ace",
      home: "claude",
      links: ["codex"],
      manual: true,
      argumentHint: "[version]",
      usage: {
        count: 6,
        last: {
          threadId: ThreadId.parse("thread-multi-day"),
          title: "Release 0.9.4",
          at: now - 3 * day,
        },
      },
    },
    {
      name: "agents-sdk",
      description: "Build agents on the Agents SDK: state, scheduling and tools.",
      body: body("Agents SDK", "Use when building an agent on the SDK."),
      scope: "personal",
      links: ["claude"],
    },
    {
      name: "git-guardrails-claude-code",
      description: "Set up hooks that block dangerous git commands before they run.",
      body: body("Git guardrails", "Use when the person wants git safety hooks."),
      scope: "personal",
      home: "claude",
    },
    {
      name: "research",
      description: "Investigate a question against primary sources and save the findings.",
      body: body("Research", "Use when the person wants a topic researched."),
      scope: "personal",
      links: ["claude"],
      usage: {
        count: 14,
        last: {
          threadId: ThreadId.parse("thread-multi-day"),
          title: "Compare stream renderers",
          at: now - day,
        },
      },
    },
    {
      name: "setup-ts-deep-modules",
      description: "Shape a TypeScript codebase into deep modules with small interfaces.",
      body: body("Deep modules", "Use when a module's interface is wider than its job."),
      scope: "personal",
      home: "codex",
    },
    {
      name: "frontend-design",
      description: "Distinctive, intentional visual design for new UI.",
      body: body("Frontend design", "Pick an aesthetic direction before writing markup."),
      scope: "personal",
      links: ["claude"],
      source: {
        source: "vercel-labs/skills",
        url: "https://github.com/vercel-labs/skills.git",
        path: "skills/frontend-design/SKILL.md",
        folderHash: "0d5b74a14bdf3ebcd64f352d06376a2ef05ed2c1",
        updatedAt: new Date(now - 30 * day).toISOString(),
      },
    },
    {
      name: "cloudflare",
      description: "Cloudflare platform skill covering Workers, Pages and storage.",
      body: body("Cloudflare", "Prefer retrieval from Cloudflare docs."),
      scope: "personal",
      home: "claude",
      copies: ["codex"],
    },
    {
      name: "ace-browser",
      description: "Open, test or debug a web page in ace's browser.",
      body: body("ace browser", "Use before browser tools."),
      scope: "builtin",
    },
    {
      name: "review-changes",
      description: "Review the changes in this worktree before they are committed or merged.",
      body: body("Review changes", "Read the diff, then the files around it."),
      scope: "builtin",
    },
  ];
  daemon.skills.seed(seeds);
}
