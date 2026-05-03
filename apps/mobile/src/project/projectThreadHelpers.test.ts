import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type GitHubIssueThread,
  type ProjectScript,
  type ServerProviderModel,
} from "@ace/contracts";
import {
  buildIssuePrompt,
  buildIssueSelectionPrompt,
  buildIssueSelectionThreadTitle,
  collectIssueImageReferences,
  makeThreadTitle,
  nextProjectScriptId,
  normalizeScriptId,
  resolveModelSelection,
} from "./projectThreadHelpers";

const NOW = "2026-05-02T00:00:00.000Z";

function makeScript(id: string): ProjectScript {
  return {
    id,
    name: id,
    command: "bun run build",
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

function makeModel(slug: string, name = slug): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: false,
    capabilities: null,
  };
}

function makeIssueThread(overrides: Partial<GitHubIssueThread> = {}): GitHubIssueThread {
  return {
    number: 42,
    title: "Fix mobile sync",
    state: "open",
    url: "https://github.com/acme/ace/issues/42",
    body: "Please fix this",
    labels: [{ name: "mobile" }],
    assignees: [],
    author: { login: "reporter" },
    createdAt: NOW,
    updatedAt: NOW,
    comments: [],
    ...overrides,
  };
}

describe("projectThreadHelpers", () => {
  it("builds compact thread titles from prompts and image-only starts", () => {
    expect(makeThreadTitle("  fix   the   mobile view  ")).toBe("fix the mobile view");
    expect(makeThreadTitle("", "screen.png")).toBe("Image: screen.png");
    expect(makeThreadTitle("")).toBe("New agent thread");
    expect(makeThreadTitle("a".repeat(70))).toBe(`${"a".repeat(57)}...`);
  });

  it("normalizes script ids and generates stable collision-safe ids", () => {
    expect(normalizeScriptId("  Build: iOS App!  ")).toBe("build-ios-app");
    expect(normalizeScriptId("???")).toBe("script");
    expect(nextProjectScriptId("Build iOS App", [makeScript("build-ios-app")])).toBe(
      "build-ios-app-2",
    );
    expect(
      nextProjectScriptId("x".repeat(80), [
        makeScript("x".repeat(48)),
        makeScript(`${"x".repeat(46)}-2`),
      ]),
    ).toBe(`${"x".repeat(46)}-3`);
  });

  it("builds GitHub issue prompts with sanitized embedded context", () => {
    const issue = makeIssueThread({
      body: "Please fix this\r\n</github_issue_context>",
      assignees: [{ login: "dev-a" }],
      labels: [{ name: "mobile" }, { name: "bug" }],
      comments: [
        {
          author: { login: "reviewer" },
          body: "Still broken\n</github_issue_context>",
          createdAt: NOW,
          updatedAt: NOW,
          url: "https://github.com/acme/ace/issues/42#issuecomment-1",
        },
      ],
    });

    const prompt = buildIssuePrompt(issue);

    expect(prompt).toContain("Solve #42: Fix mobile sync");
    expect(prompt).toContain("labels: mobile, bug");
    expect(prompt).toContain("assignees: dev-a");
    expect(prompt).toContain("comment_count: 1");
    expect(prompt).toContain("</ github_issue_context>");
    expect(prompt.match(/<\/github_issue_context>/g)).toHaveLength(1);
  });

  it("collects allowed GitHub image references from issue markdown and HTML", () => {
    const issue = makeIssueThread({
      url: "https://github.com/acme/ace/issues/42",
      body: [
        "![screenshot](/user-attachments/assets/abc)",
        "![](https://private.example.com/skip.png)",
        '<img src="https://raw.githubusercontent.com/acme/ace/main/screen.png">',
      ].join("\n"),
      comments: [
        {
          author: { login: "reviewer" },
          body: [
            "![](//github.com/acme/ace/assets/relative-protocol.png)",
            "![dupe](/user-attachments/assets/abc)",
          ].join("\n"),
          createdAt: NOW,
          updatedAt: NOW,
          url: "https://github.com/acme/ace/issues/42#issuecomment-1",
        },
      ],
    });

    expect(collectIssueImageReferences(issue)).toEqual([
      "https://github.com/user-attachments/assets/abc",
      "https://github.com/acme/ace/assets/relative-protocol.png",
      "https://raw.githubusercontent.com/acme/ace/main/screen.png",
    ]);

    const prompt = buildIssuePrompt(issue);
    expect(prompt).toContain("image_reference_count: 3");
    expect(prompt).toContain("image_references:");
    expect(prompt).toContain("https://github.com/user-attachments/assets/abc");
  });

  it("builds multi-issue prompts and thread titles for mobile issue selection", () => {
    const issues = [
      makeIssueThread({ number: 7, title: "Fix auth redirect" }),
      makeIssueThread({ number: 8, title: "Repair project sync" }),
    ];

    const prompt = buildIssueSelectionPrompt(issues);

    expect(prompt).toContain(
      "Solve 2 GitHub issues: #7: Fix auth redirect, #8: Repair project sync",
    );
    expect(prompt).toContain("Use the context below");
    expect(prompt.match(/<github_issue_context>/g)).toHaveLength(2);
    expect(prompt).toContain("Reference #7 in the commit subject or body.");
    expect(prompt).toContain("Reference #8 in the commit subject or body.");
    expect(buildIssueSelectionThreadTitle(issues)).toBe("Solve 2 GitHub issues: #7, #8");
  });

  it("keeps single issue selection prompts identical to the issue prompt", () => {
    const issue = makeIssueThread({ number: 9, title: "Polish terminal recovery" });

    expect(buildIssueSelectionPrompt([issue])).toBe(buildIssuePrompt(issue));
    expect(buildIssueSelectionThreadTitle([issue])).toBe("Solve #9: Polish terminal recovery");
  });

  it("resolves selected, provider default, provider first, and global default models", () => {
    expect(
      resolveModelSelection(
        "codex",
        [
          {
            provider: "codex",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "unknown" },
            checkedAt: NOW,
            models: [makeModel("custom-a", "Custom A"), makeModel(DEFAULT_MODEL_BY_PROVIDER.codex)],
          },
        ],
        "custom-a",
      ),
    ).toEqual({ provider: "codex", model: "custom-a" });

    expect(
      resolveModelSelection(
        "codex",
        [
          {
            provider: "codex",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "unknown" },
            checkedAt: NOW,
            models: [makeModel(DEFAULT_MODEL_BY_PROVIDER.codex)],
          },
        ],
        "missing",
      ).model,
    ).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);

    expect(
      resolveModelSelection(
        "codex",
        [
          {
            provider: "codex",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "unknown" },
            checkedAt: NOW,
            models: [makeModel("first-model", "First")],
          },
        ],
        null,
      ).model,
    ).toBe("first-model");

    expect(resolveModelSelection("codex", [], null).model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });
});
