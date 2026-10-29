import { describe, expect, it } from "vitest";
import {
  asMarkitReferenceKind,
  isMarkitWebImage,
  markitLinkTarget,
  markitWorkerPath,
  shouldResolveMarkitImage,
} from "./index.ts";

describe("markit worker path stays under the app's static markit dir", () => {
  it("serves the worker from /markit by default", () => {
    expect(markitWorkerPath()).toBe("/markit/worker.js");
  });

  it("prefixes an app base path when one is set", () => {
    expect(markitWorkerPath("/ace")).toBe("/ace/markit/worker.js");
  });
});

describe("markit image policy never fetches the web on its own", () => {
  it("resolves bytes already on the page", () => {
    expect(shouldResolveMarkitImage("data:image/png;base64,aaa")).toBe(true);
    expect(shouldResolveMarkitImage("blob:https://ace/1")).toBe(true);
  });

  it("refuses thread paths, file urls and web addresses", () => {
    expect(shouldResolveMarkitImage("notes/shot.png")).toBe(false);
    expect(shouldResolveMarkitImage("file:///tmp/a.png")).toBe(false);
    expect(shouldResolveMarkitImage("https://example.com/a.png")).toBe(false);
  });

  it("marks http(s) images as links the person opens", () => {
    expect(isMarkitWebImage("https://example.com/a.png")).toBe(true);
    expect(isMarkitWebImage("data:image/png;base64,aaa")).toBe(false);
    expect(isMarkitWebImage("notes/shot.png")).toBe(false);
  });
});

describe("markit reference kinds stay app actions, never navigation", () => {
  it("keeps file, thread and pull-request references", () => {
    expect(asMarkitReferenceKind("file")).toBe("file");
    expect(asMarkitReferenceKind("thread")).toBe("thread");
    expect(asMarkitReferenceKind("pull_request")).toBe("pull_request");
  });

  it("drops anything else so it falls back to a normal link", () => {
    expect(asMarkitReferenceKind("https")).toBeUndefined();
    expect(asMarkitReferenceKind("")).toBeUndefined();
  });
});

describe("links in markit prose go only where they are safe", () => {
  it("sends web and mail addresses to the browser", () => {
    expect(markitLinkTarget("https://example.com/a b")).toEqual({
      kind: "web",
      href: "https://example.com/a%20b",
    });
    expect(markitLinkTarget("mailto:a@b.dev")).toEqual({ kind: "web", href: "mailto:a@b.dev" });
  });

  it("keeps ace and thread links inside the app", () => {
    expect(markitLinkTarget("ace://thread/t1")).toEqual({ kind: "ace", href: "ace://thread/t1" });
    expect(markitLinkTarget("thread://t1")).toEqual({ kind: "ace", href: "thread://t1" });
  });

  it("treats relative paths and file urls as files on the thread host", () => {
    expect(markitLinkTarget("src/a.ts")).toEqual({ kind: "local", path: "src/a.ts" });
    expect(markitLinkTarget("./a.ts")).toEqual({ kind: "local", path: "./a.ts" });
    expect(markitLinkTarget("file:///tmp/a.ts")).toEqual({
      kind: "local",
      path: "file:///tmp/a.ts",
    });
  });

  it("refuses script, data and unknown schemes", () => {
    expect(markitLinkTarget("javascript:alert(1)")).toBeUndefined();
    expect(markitLinkTarget("data:text/html,x")).toBeUndefined();
    expect(markitLinkTarget("vscode://file/a")).toBeUndefined();
    expect(markitLinkTarget("  ")).toBeUndefined();
  });
});
