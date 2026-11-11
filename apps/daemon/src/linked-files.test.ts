import { describe, expect, test } from "vitest";
import { linkedReferences, localReference } from "./linked-files.ts";

/*
 * Which files an answer grants, and the local path each names. The download itself is covered
 * end to end in linked-files.process.test.ts; these are the path rules on every platform.
 */

describe("what an answer grants", () => {
  test("absolute, home and Windows paths an answer names in code or prose are granted", () => {
    const granted = linkedReferences(
      [
        "Wrote `/tmp/report.pdf` and ~/Downloads/notes.txt.",
        "On Windows it is `C:\\Users\\dev\\Downloads\\report.pdf` or ~\\Desktop\\todo.md.",
        "The source is src/app/x.tsx.",
      ].join("\n"),
    );
    for (const path of [
      "/tmp/report.pdf",
      "~/Downloads/notes.txt",
      "C:\\Users\\dev\\Downloads\\report.pdf",
      "~\\Desktop\\todo.md",
    ])
      expect(granted.has(path), path).toBe(true);
    expect(granted.has("src/app/x.tsx")).toBe(false);
  });
});

describe("the local path a link names", () => {
  test("a Windows drive path is a path, not a URL scheme", () => {
    expect(localReference("C:\\Users\\dev\\a.pdf")).toBe("C:\\Users\\dev\\a.pdf");
    expect(localReference("C:/Users/dev/a.pdf:12")).toBe("C:/Users/dev/a.pdf");
  });

  test("web and other scheme links name no local file", () => {
    expect(localReference("https://example.com/a.pdf")).toBeUndefined();
    expect(localReference("mailto:dev@example.com")).toBeUndefined();
  });
});
