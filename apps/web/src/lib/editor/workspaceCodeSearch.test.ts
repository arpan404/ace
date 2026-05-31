import type { ProjectEntry } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceCodeSearchQueries,
  createWorkspaceCodeSearchResult,
  extractWorkspaceCodeSearchTerms,
  groupWorkspaceCodeSearchResults,
  highlightWorkspaceCodeSearchText,
} from "./workspaceCodeSearch";

function createFileEntry(path: string): ProjectEntry {
  const segments = path.split("/");
  return {
    kind: "file",
    parentPath: segments.length > 1 ? segments.slice(0, -1).join("/") : undefined,
    path,
  };
}

describe("workspaceCodeSearch", () => {
  it("extracts useful terms from natural language search", () => {
    expect(extractWorkspaceCodeSearchTerms("where is auth token refresh code sitting?")).toEqual([
      "auth",
      "token",
      "refresh",
    ]);
  });

  it("builds path and content search fanout queries", () => {
    expect(buildWorkspaceCodeSearchQueries("auth token refresh")).toEqual([
      "auth token refresh",
      "content:auth token refresh",
      "content:auth",
      "content:token",
      "content:refresh",
    ]);
  });

  it("does not treat explicit search prefixes as content terms", () => {
    expect(buildWorkspaceCodeSearchQueries("content:useMutation")).toEqual([
      "content:useMutation",
      "content:usemutation",
    ]);
  });

  it("creates line snippets for content matches", () => {
    const result = createWorkspaceCodeSearchResult({
      contents: [
        "export function refreshAuthToken() {",
        "  return tokenStore.refresh();",
        "}",
      ].join("\n"),
      entry: createFileEntry("src/auth/tokens.ts"),
      query: "where is auth token refresh handled",
    });

    expect(result?.entry.path).toBe("src/auth/tokens.ts");
    expect(result?.matchCount).toBeGreaterThan(0);
    expect(result?.snippets.map((snippet) => snippet.lineNumber)).toEqual([1, 2]);
  });

  it("groups likely, content, and path matches", () => {
    const likely = createWorkspaceCodeSearchResult({
      contents: "auth token refresh token refresh",
      entry: createFileEntry("src/auth/tokens.ts"),
      query: "auth token refresh",
    });
    const content = createWorkspaceCodeSearchResult({
      contents: "refresh()",
      entry: createFileEntry("src/session/run.ts"),
      query: "refresh",
    });
    const path = createWorkspaceCodeSearchResult({
      contents: "",
      entry: createFileEntry("src/auth/path-only.ts"),
      query: "auth",
    });

    const groups = groupWorkspaceCodeSearchResults(
      [likely, content, path].flatMap((result) => (result ? [result] : [])),
    );

    expect(groups.map((group) => group.id)).toEqual(["likely", "content", "path"]);
  });

  it("highlights matched terms in snippets", () => {
    expect(highlightWorkspaceCodeSearchText("refreshAuthToken()", "auth token")).toEqual([
      { highlight: false, text: "refresh" },
      { highlight: true, text: "Auth" },
      { highlight: true, text: "Token" },
      { highlight: false, text: "()" },
    ]);
  });
});
