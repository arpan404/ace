import type { ProjectEntry } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  mergeWorkspaceSearchEntries,
  searchWorkspaceEntriesLocally,
  shouldRunWorkspaceRemoteSearch,
} from "./workspaceEntrySearch";

function createFileEntry(path: string): ProjectEntry {
  const segments = path.split("/");
  return {
    kind: "file",
    parentPath: segments.length > 1 ? segments.slice(0, -1).join("/") : undefined,
    path,
  };
}

describe("workspaceEntrySearch", () => {
  it("keeps path matches ahead of remote content-only matches", () => {
    const buttonFile = createFileEntry("src/components/Button.tsx");
    const iconButtonFile = createFileEntry("src/components/IconButton.tsx");
    const guideFile = createFileEntry("docs/design-guidelines.md");

    expect(
      mergeWorkspaceSearchEntries(
        searchWorkspaceEntriesLocally([guideFile, iconButtonFile, buttonFile], "button"),
        [guideFile, buttonFile],
      ).map((entry) => entry.path),
    ).toEqual([
      "src/components/Button.tsx",
      "src/components/IconButton.tsx",
      "docs/design-guidelines.md",
    ]);
  });

  it("supports regex path search locally", () => {
    expect(
      searchWorkspaceEntriesLocally(
        [
          createFileEntry("src/components/Button.tsx"),
          createFileEntry("src/components/Button.test.tsx"),
          createFileEntry("README.md"),
        ],
        "re:^src/.+\\.test\\.tsx$",
      ).map((entry) => entry.path),
    ).toEqual(["src/components/Button.test.tsx"]);
  });

  it("only runs remote search for non-regex queries with enough signal", () => {
    expect(shouldRunWorkspaceRemoteSearch("b")).toBe(false);
    expect(shouldRunWorkspaceRemoteSearch("button")).toBe(true);
    expect(shouldRunWorkspaceRemoteSearch("content:button")).toBe(true);
    expect(shouldRunWorkspaceRemoteSearch("re:button")).toBe(false);
  });
});
