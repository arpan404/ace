import { describe, expect, it } from "vitest";

import {
  buildWorkspacePreviewHttpUrl,
  canOpenFileExternallyFromReadError,
  detectWorkspacePreviewKind,
  joinWorkspaceAbsolutePath,
  revealInFileManagerLabel,
} from "./workspaceFilePreview";

describe("workspaceFilePreview", () => {
  it("detects image and video previews", () => {
    expect(detectWorkspacePreviewKind("assets/logo.svg")).toBe("image");
    expect(detectWorkspacePreviewKind("captures/demo.mp4")).toBe("video");
  });

  it("detects markdown and mermaid previews", () => {
    expect(detectWorkspacePreviewKind("README.md")).toBe("markdown");
    expect(detectWorkspacePreviewKind("docs/architecture.markdown")).toBe("markdown");
    expect(detectWorkspacePreviewKind("diagrams/flow.mermaid")).toBe("mermaid");
    expect(detectWorkspacePreviewKind("diagrams/flow.mmd")).toBe("mermaid");
  });

  it("returns null for unsupported file extensions", () => {
    expect(detectWorkspacePreviewKind("src/main.ts")).toBeNull();
    expect(detectWorkspacePreviewKind("LICENSE")).toBeNull();
  });

  it("joins workspace paths using the workspace separator", () => {
    expect(joinWorkspaceAbsolutePath("/repo/app/", "src/index.ts")).toBe("/repo/app/src/index.ts");
    expect(joinWorkspaceAbsolutePath("C:\\repo\\app", "src/index.ts")).toBe(
      "C:\\repo\\app\\src\\index.ts",
    );
  });

  it("builds direct workspace preview http urls from websocket urls", () => {
    expect(
      buildWorkspacePreviewHttpUrl("ws://127.0.0.1:3020/ws?token=abc", "/repo/app", "docs/a b.md"),
    ).toBe("http://127.0.0.1:3020/api/workspace-file?cwd=%2Frepo%2Fapp&relativePath=docs%2Fa+b.md");
    expect(
      buildWorkspacePreviewHttpUrl("wss://host.example/ws", "C:\\repo", "assets\\logo.png"),
    ).toBe(
      "https://host.example/api/workspace-file?cwd=C%3A%5Crepo&relativePath=assets%5Clogo.png",
    );
  });

  it("does not build http preview urls for relay or invalid connection urls", () => {
    expect(
      buildWorkspacePreviewHttpUrl(
        "ace-relay://relay.example/connect?hostDeviceId=device",
        "/repo",
        "logo.png",
      ),
    ).toBeNull();
    expect(buildWorkspacePreviewHttpUrl("https://example.com/ws", "/repo", "logo.png")).toBeNull();
  });

  it("labels native reveal actions by platform", () => {
    expect(revealInFileManagerLabel("MacIntel")).toBe("Reveal in Finder");
    expect(revealInFileManagerLabel("Win32")).toBe("Reveal in Explorer");
    expect(revealInFileManagerLabel("Linux x86_64")).toBe("Reveal in File Manager");
  });

  it("identifies read errors that can be opened externally", () => {
    expect(canOpenFileExternallyFromReadError("Binary files are not supported")).toBe(true);
    expect(canOpenFileExternallyFromReadError("Only UTF-8 text files are supported")).toBe(true);
    expect(canOpenFileExternallyFromReadError("Files larger than 10 MB are blocked")).toBe(true);
    expect(canOpenFileExternallyFromReadError("Permission denied")).toBe(false);
  });
});
