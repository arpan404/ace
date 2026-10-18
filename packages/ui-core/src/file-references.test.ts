import { describe, expect, test } from "vitest";
import {
  codeFileReference,
  fileTextSpans,
  resolveFileReference,
  workspaceRelative,
} from "./file-references.ts";

describe("inline code", () => {
  test("a bare filename, a relative path and an absolute path count as files", () => {
    expect(codeFileReference("loader.ts")).toEqual({ path: "loader.ts" });
    expect(codeFileReference("src/app/x.tsx")).toEqual({ path: "src/app/x.tsx" });
    expect(codeFileReference("/Users/dev/acme/a.ts")).toEqual({ path: "/Users/dev/acme/a.ts" });
    expect(codeFileReference("./README.md")).toEqual({ path: "./README.md" });
  });

  test("line and column suffixes are read in both colon and #L forms", () => {
    expect(codeFileReference("src/app/x.tsx:42")).toEqual({ path: "src/app/x.tsx", line: 42 });
    expect(codeFileReference("a.ts:7:3")).toEqual({ path: "a.ts", line: 7, column: 3 });
    expect(codeFileReference("apps/web/src/a.ts#L10")).toEqual({
      path: "apps/web/src/a.ts",
      line: 10,
    });
    expect(codeFileReference("a.ts#L10-L20")).toEqual({ path: "a.ts", line: 10 });
  });

  test("code that is not a file reference stays code", () => {
    for (const text of [
      "a < b && c",
      "https://ace.dev/a.ts",
      "bun run test",
      "1.2.3",
      "foo()",
      "obj.method()",
      "README",
      "me@example.com",
      "src/app/",
      "~/notes.md",
      "file:///tmp/a.ts",
    ])
      expect(codeFileReference(text), text).toBeUndefined();
  });
});

const files = (text: string) =>
  fileTextSpans(text).flatMap((span) => (span.kind === "file" ? [span.reference] : []));

describe("plain text", () => {
  test("a path with a folder or a line becomes a reference, punctuation left out", () => {
    expect(fileTextSpans("See src/lib/fetch.ts, then app.tsx:12.")).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "file",
        text: "src/lib/fetch.ts",
        reference: { path: "src/lib/fetch.ts" },
      },
      { kind: "text", text: ", then " },
      { kind: "file", text: "app.tsx:12", reference: { path: "app.tsx", line: 12 } },
      { kind: "text", text: "." },
    ]);
  });

  test("words that only look like files, URLs and versions are left alone", () => {
    expect(files("Built on Node.js and Vue.js 3.4.1, e.g. v2.0.")).toEqual([]);
    expect(files("Docs at https://ace.dev/guide/start.html and www.example.com/a.ts")).toEqual([]);
    expect(files("Install @scope/pkg or email dev@acme.io/x.ts")).toEqual([]);
  });

  test("text without any reference comes back unchanged as one span", () => {
    const text = "Nothing to link here.";
    expect(fileTextSpans(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("resolution", () => {
  const index = [
    "apps/server/src/resume.ts",
    "apps/mobile/src/resume.ts",
    "apps/web/src/relay/socket.ts",
    "README.md",
  ];

  test("a full path resolves exactly and a bare name to its one match", () => {
    expect(resolveFileReference("README.md", index)).toEqual({ kind: "file", path: "README.md" });
    expect(resolveFileReference("socket.ts", index)).toEqual({
      kind: "file",
      path: "apps/web/src/relay/socket.ts",
    });
    expect(resolveFileReference("relay/socket.ts", index)).toEqual({
      kind: "file",
      path: "apps/web/src/relay/socket.ts",
    });
  });

  test("two matches are ambiguous and no match is none; a name never matches mid-segment", () => {
    expect(resolveFileReference("resume.ts", index)).toEqual({
      kind: "ambiguous",
      paths: ["apps/server/src/resume.ts", "apps/mobile/src/resume.ts"],
    });
    expect(resolveFileReference("ocket.ts", index)).toEqual({ kind: "none" });
    expect(resolveFileReference("../outside.ts", index)).toEqual({ kind: "none" });
  });

  test("absolute paths are made workspace-relative only under the workspace root", () => {
    expect(workspaceRelative("/Users/dev/acme/src/a.ts", "/Users/dev/acme/")).toBe("src/a.ts");
    expect(workspaceRelative("/etc/hosts.conf", "/Users/dev/acme")).toBeUndefined();
    expect(workspaceRelative("./src/a.ts", undefined)).toBe("src/a.ts");
  });
});
