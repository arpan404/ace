import { describe, expect, it } from "vitest";

import {
  appendPathSegment,
  findExistingProjectByPath,
  hasTrailingPathSeparator,
  inferProjectTitle,
  parentPath,
  resolveProjectPath,
  toBrowseDirectoryPath,
} from "./projectPaths";

describe("projectPaths", () => {
  it("detects trailing separators", () => {
    expect(hasTrailingPathSeparator("/tmp/project/")).toBe(true);
    expect(hasTrailingPathSeparator("C:\\tmp\\project\\")).toBe(true);
    expect(hasTrailingPathSeparator("/tmp/project")).toBe(false);
  });

  it("appends path segments with the current separator", () => {
    expect(appendPathSegment("/tmp/project", "src")).toBe("/tmp/project/src");
    expect(appendPathSegment("C:\\tmp\\project", "src")).toBe("C:\\tmp\\project\\src");
  });

  it("resolves parent paths", () => {
    expect(parentPath("/tmp/project/src")).toBe("/tmp/project");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("C:\\tmp\\project\\src")).toBe("C:\\tmp\\project");
    expect(parentPath("C:\\")).toBe("C:\\");
  });

  it("normalizes browse directory inputs to include trailing separators", () => {
    expect(toBrowseDirectoryPath("/tmp/project")).toBe("/tmp/project/");
    expect(toBrowseDirectoryPath("C:\\tmp\\project")).toBe("C:\\tmp\\project\\");
  });

  it("resolves explicit relative project paths", () => {
    expect(resolveProjectPath("./apps/web", "/repo")).toBe("/repo/apps/web");
    expect(resolveProjectPath("../shared", "/repo/apps/web")).toBe("/repo/apps/shared");
  });

  it("infers project titles from paths", () => {
    expect(inferProjectTitle("/tmp/my-project")).toBe("my-project");
    expect(inferProjectTitle("C:\\tmp\\my-project\\")).toBe("my-project");
  });

  it("deduplicates projects by normalized path", () => {
    const projects = [{ cwd: "/tmp/project" }, { cwd: "C:\\Repo\\App" }];

    expect(findExistingProjectByPath(projects, "/tmp/project/")).toEqual({ cwd: "/tmp/project" });
    expect(findExistingProjectByPath(projects, "c:\\repo\\app\\")).toEqual({
      cwd: "C:\\Repo\\App",
    });
  });

  it("does not resolve absolute paths even when cwd is provided", () => {
    expect(resolveProjectPath("/Users/user/code/myproject", "/base")).toBe(
      "/Users/user/code/myproject",
    );
    expect(resolveProjectPath("C:\\Users\\user\\code\\myproject", "C:\\base")).toBe(
      "C:\\Users\\user\\code\\myproject",
    );
  });

  it("still resolves relative paths with cwd", () => {
    expect(resolveProjectPath("./myproject", "/base")).toBe("/base/myproject");
    expect(resolveProjectPath("../myproject", "/base/code")).toBe("/base/myproject");
  });
});
