import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentEnvironment,
  NotesConfig,
  notesAgentCommand,
  notesFromReply,
  notesPrompt,
  previousReleaseTag,
  prNumbersFromLog,
} from "./release-notes-input.ts";

describe("where a release's notes start", () => {
  const published = [
    "v0.0.22",
    "v0.0.23",
    "ace-0.0.24-beta-1",
    "ace-0.0.24-beta-2",
    "ace-0.0.25-beta-1",
  ];

  it("counts a stable release from the previous stable one, past every beta", () => {
    expect(previousReleaseTag(published, "v0.0.24")).toBe("v0.0.23");
  });

  it("counts a beta from the previous beta of its version", () => {
    expect(previousReleaseTag(published, "ace-0.0.24-beta-3")).toBe("ace-0.0.24-beta-2");
  });

  it("counts a version's first beta from the last stable release", () => {
    expect(previousReleaseTag(["v0.0.23", "v0.0.24"], "ace-0.0.25-beta-1")).toBe("v0.0.24");
  });

  it("orders build numbers numerically", () => {
    const betas = ["ace-0.0.24-beta-9", "ace-0.0.24-beta-10"];
    expect(previousReleaseTag(betas, "ace-0.0.24-beta-11")).toBe("ace-0.0.24-beta-10");
  });

  it("has no start for the first release", () => {
    expect(previousReleaseTag([], "v0.0.1")).toBeUndefined();
  });
});

describe("the PRs in a release's range", () => {
  it("reads merge and squash commits, oldest first, and skips direct pushes", () => {
    const log = [
      "Beta: peeled corner on the Dock icon (#2295)",
      "Fix a typo",
      "Merge pull request #2198 from arpan404/ace/work-card-tree-sync",
      "Merge pull request #2198 from arpan404/ace/work-card-tree-sync",
    ];
    expect(prNumbersFromLog(log)).toEqual([2198, 2295]);
  });
});

describe("the agent's prompt", () => {
  const limits = { bulletChars: 200, bullets: 12, totalChars: 3000 };
  const prs = [
    {
      number: 7,
      title: "Faster search",
      body: "Results appear as you type.",
      labels: [{ name: "ui" }],
    },
  ];

  it("names the release, its sections and limits, and every PR with its body and labels", () => {
    const prompt = notesPrompt({
      template: "{{release}} | {{sections}} | {{bulletChars}}/{{bullets}}\n{{prs}}",
      title: "ace 0.0.24 beta 1",
      kind: "beta",
      prs,
      limits,
    });
    expect(prompt).toBe(
      "ace 0.0.24 beta 1 | New, Improved, Fixed, Known issues | 200/12\n### #7: Faster search\nLabels: ui\nResults appear as you type.",
    );
  });

  it("tells the retry every problem the first notes had", () => {
    const prompt = notesPrompt({
      template: "x",
      title: "ace 0.0.24",
      kind: "stable",
      prs,
      limits,
      problems: ["Mentions Copilot"],
    });
    expect(prompt).toContain("- Mentions Copilot");
  });
});

describe("running the notes agent", () => {
  const config = NotesConfig.parse(
    JSON.parse(readFileSync(join(import.meta.dirname, "../../../../release/notes.json"), "utf8")),
  );

  it("gives Claude no tools or MCP servers, at the configured model and effort", () => {
    const { command, args } = notesAgentCommand({ ...config, effort: "high" });
    expect(command).toBe("claude");
    expect(args.join(" ")).toContain(
      "--model claude-sonnet-5-5 --effort high --tools  --strict-mcp-config",
    );
  });

  it("runs Codex in its read-only sandbox at the configured effort", () => {
    const { command, args } = notesAgentCommand({ ...config, provider: "codex", model: "gpt-x" });
    expect(command).toBe("codex");
    expect(args).toEqual(
      expect.arrayContaining(["--sandbox", "read-only", 'model_reasoning_effort="medium"']),
    );
  });

  it("runs the agent without the job's GitHub token or the runner's variables", () => {
    const env = agentEnvironment({
      HOME: "/home/ace-ci",
      PATH: "/usr/bin",
      GH_TOKEN: "ghs_secret",
      GITHUB_TOKEN: "ghs_secret",
      ACTIONS_RUNTIME_TOKEN: "secret",
      CLOUDFLARE_API_TOKEN: "secret",
    });
    expect(env).toEqual({ HOME: "/home/ace-ci", PATH: "/usr/bin" });
  });

  it("takes the notes out of a code fence the agent wrapped them in", () => {
    expect(notesFromReply("```markdown\n## New\n\n- A (#1)\n```\n")).toBe("## New\n\n- A (#1)\n");
    expect(notesFromReply("## New\n- A (#1)")).toBe("## New\n- A (#1)\n");
  });
});
