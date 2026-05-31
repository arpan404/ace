import { describe, expect, it } from "vitest";

import {
  createWorkspaceShikiTokenStyle,
  resolveWorkspaceShikiLanguage,
} from "./workspaceShikiHighlight";

describe("resolveWorkspaceShikiLanguage", () => {
  it("selects file-specific Shiki grammars for TypeScript and JavaScript variants", () => {
    expect(
      resolveWorkspaceShikiLanguage({
        filePath: "apps/web/src/App.tsx",
        languageId: "typescript",
      }),
    ).toBe("tsx");
    expect(
      resolveWorkspaceShikiLanguage({
        filePath: "apps/web/src/bootstrap.mjs",
        languageId: "javascript",
      }),
    ).toBe("mjs");
  });

  it("maps workspace language ids to bundled Shiki grammars", () => {
    expect(
      resolveWorkspaceShikiLanguage({ filePath: "Dockerfile", languageId: "dockerfile" }),
    ).toBe("docker");
    expect(resolveWorkspaceShikiLanguage({ filePath: ".env.local", languageId: "dotenv" })).toBe(
      "dotenv",
    );
    expect(resolveWorkspaceShikiLanguage({ filePath: "schema.prisma", languageId: "prisma" })).toBe(
      "prisma",
    );
    expect(resolveWorkspaceShikiLanguage({ filePath: "build.sh", languageId: "shell" })).toBe(
      "shellscript",
    );
  });

  it("returns null for unsupported or missing language ids", () => {
    expect(
      resolveWorkspaceShikiLanguage({ filePath: "README.unknown", languageId: undefined }),
    ).toBeNull();
    expect(
      resolveWorkspaceShikiLanguage({
        filePath: "README.unknown",
        languageId: "unknown-language",
      }),
    ).toBeNull();
  });
});

describe("createWorkspaceShikiTokenStyle", () => {
  it("converts Shiki token styles into inline CodeMirror decoration styles", () => {
    expect(
      createWorkspaceShikiTokenStyle({
        color: "#f8fafc",
        fontStyle: 3 as NonNullable<
          Parameters<typeof createWorkspaceShikiTokenStyle>[0]["fontStyle"]
        >,
      }),
    ).toBe("color: #f8fafc; font-style: italic; font-weight: 700");
  });

  it("returns null when Shiki has no visual style for a token", () => {
    expect(createWorkspaceShikiTokenStyle({})).toBeNull();
  });
});
