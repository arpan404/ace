import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { pathWithin } from "./uploads.ts";

describe("upload containment", () => {
  it("treats a Windows file above the workspace as outside it", () => {
    expect(pathWithin("C:\\work\\repo", "C:\\Users\\me\\secret.txt", win32)).toBe(false);
    expect(pathWithin("C:\\work\\repo", "C:\\work\\other\\a.txt", win32)).toBe(false);
    expect(pathWithin("C:\\work\\repo", "C:\\work", win32)).toBe(false);
  });

  it("treats a file on another Windows drive as outside the workspace", () => {
    expect(pathWithin("C:\\work\\repo", "D:\\work\\repo\\a.txt", win32)).toBe(false);
  });

  it("accepts Windows files inside the workspace, ignoring drive-letter case", () => {
    expect(pathWithin("C:\\work\\repo", "C:\\work\\repo\\src\\a.txt", win32)).toBe(true);
    expect(pathWithin("C:\\work\\repo", "c:\\work\\repo\\a.txt", win32)).toBe(true);
    expect(pathWithin("C:\\work\\repo", "C:\\work\\repo", win32)).toBe(true);
  });

  it("accepts a workspace file whose name starts with two dots", () => {
    expect(pathWithin("C:\\work\\repo", "C:\\work\\repo\\..notes", win32)).toBe(true);
    expect(pathWithin("/work/repo", "/work/repo/..notes", posix)).toBe(true);
  });

  it("treats a POSIX file above the workspace as outside it", () => {
    expect(pathWithin("/work/repo", "/home/me/secret.txt", posix)).toBe(false);
    expect(pathWithin("/work/repo", "/work/repo/sub/a.txt", posix)).toBe(true);
  });
});
