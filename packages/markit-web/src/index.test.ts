import { describe, expect, it } from "vitest";
import {
  asMarkitReferenceKind,
  isMarkitWebImage,
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
