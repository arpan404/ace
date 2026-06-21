import { describe, expect, it } from "vitest";

import {
  countWorkspaceFindMatches,
  createWorkspaceFindQuery,
  EMPTY_WORKSPACE_FIND_STATE,
  resolveWorkspaceFindSeed,
} from "./workspaceFind";

describe("workspaceFind", () => {
  it("builds literal search queries by default", () => {
    const query = createWorkspaceFindQuery({
      ...EMPTY_WORKSPACE_FIND_STATE,
      caseSensitive: true,
      search: "foo.bar",
      wholeWord: true,
    });

    expect(query.search).toBe("foo.bar");
    expect(query.caseSensitive).toBe(true);
    expect(query.literal).toBe(true);
    expect(query.regexp).toBe(false);
    expect(query.wholeWord).toBe(true);
  });

  it("builds regular expression queries when requested", () => {
    const query = createWorkspaceFindQuery({
      ...EMPTY_WORKSPACE_FIND_STATE,
      regexp: true,
      replace: "$1",
      search: "use(Effect|Memo)",
    });

    expect(query.valid).toBe(true);
    expect(query.literal).toBe(false);
    expect(query.regexp).toBe(true);
    expect(query.replace).toBe("$1");
  });

  it("treats invalid regular expressions as zero matches", () => {
    const query = createWorkspaceFindQuery({
      ...EMPTY_WORKSPACE_FIND_STATE,
      regexp: true,
      search: "[",
    });

    expect(query.valid).toBe(false);
    expect(countWorkspaceFindMatches("const value = 1;", query)).toEqual({
      capped: false,
      count: 0,
    });
  });

  it("prefers safe selected text over current word for seeding", () => {
    expect(
      resolveWorkspaceFindSeed({
        currentWord: "fallback",
        selectedText: " selected\ntext ",
      }),
    ).toBe("selected text");
  });

  it("caps match counting for large files", () => {
    const query = createWorkspaceFindQuery({
      ...EMPTY_WORKSPACE_FIND_STATE,
      search: "match",
    });

    expect(countWorkspaceFindMatches("match\n".repeat(1_200), query, 1_000)).toEqual({
      capped: true,
      count: 1_000,
    });
  });
});
