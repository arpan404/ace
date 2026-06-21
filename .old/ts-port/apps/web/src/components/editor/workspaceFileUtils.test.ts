import { describe, expect, it } from "vitest";

import { detectWorkspacePreviewKind } from "./workspaceFileUtils";

describe("detectWorkspacePreviewKind", () => {
  it("detects image and video previews", () => {
    expect(detectWorkspacePreviewKind("assets/logo.svg")).toBe("image");
    expect(detectWorkspacePreviewKind("captures/demo.mp4")).toBe("video");
  });

  it("detects markdown previews", () => {
    expect(detectWorkspacePreviewKind("README.md")).toBe("markdown");
    expect(detectWorkspacePreviewKind("docs/architecture.markdown")).toBe("markdown");
  });

  it("detects mermaid previews", () => {
    expect(detectWorkspacePreviewKind("diagrams/flow.mermaid")).toBe("mermaid");
    expect(detectWorkspacePreviewKind("diagrams/flow.mmd")).toBe("mermaid");
  });

  it("returns null for unsupported file extensions", () => {
    expect(detectWorkspacePreviewKind("src/main.ts")).toBeNull();
    expect(detectWorkspacePreviewKind("LICENSE")).toBeNull();
  });
});
