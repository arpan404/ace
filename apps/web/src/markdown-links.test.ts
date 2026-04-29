import { describe, expect, it } from "vitest";

import { resolveMarkdownFileLinkTarget, resolveWorkspaceEditorFilePath } from "./markdown-links";

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("resolveWorkspaceEditorFilePath", () => {
  it("maps workspace absolute paths to workspace-relative editor paths", () => {
    expect(
      resolveWorkspaceEditorFilePath(
        "/Users/julius/project/src/main.ts:42:7",
        "/Users/julius/project",
      ),
    ).toBe("src/main.ts");
  });

  it("supports windows absolute paths with case-insensitive workspace roots", () => {
    expect(
      resolveWorkspaceEditorFilePath("C:\\Code\\Project\\src\\index.ts:9", "c:\\code\\project"),
    ).toBe("src/index.ts");
  });

  it("returns absolute paths when they are outside the workspace root", () => {
    expect(
      resolveWorkspaceEditorFilePath("/Users/julius/other/main.ts:10", "/Users/julius/project"),
    ).toBe("/Users/julius/other/main.ts");
  });
});
