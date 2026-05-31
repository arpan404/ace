import { describe, expect, it } from "vitest";

import {
  createWorkspaceShikiTokenStyle,
  highlightWorkspaceShikiHtmlLines,
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

  it("infers bundled Shiki grammars from file paths when no language id is available", () => {
    expect(
      resolveWorkspaceShikiLanguage({
        filePath: "Apps/Desktop/Sources/AndyDesktopApp.swift",
        languageId: undefined,
      }),
    ).toBe("swift");
    expect(
      resolveWorkspaceShikiLanguage({
        filePath: "apps/web/src/components/App.tsx",
        languageId: undefined,
      }),
    ).toBe("tsx");
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

describe("highlightWorkspaceShikiHtmlLines", () => {
  it("returns styled HTML for file-path-only Swift diff lines", async () => {
    const [line] = await highlightWorkspaceShikiHtmlLines({
      filePath: "Apps/Desktop/Sources/AndyDesktopApp.swift",
      lines: ["struct AndyDesktopApp: App {\n"],
      resolvedTheme: "dark",
    });

    expect(line).toContain("<span");
    expect(line).toContain("color:");
    expect(line).toContain("AndyDesktopApp");
  });

  it("escapes plain fallback HTML for unsupported files", async () => {
    const [line] = await highlightWorkspaceShikiHtmlLines({
      filePath: "notes.unknown",
      lines: ['<unsafe attr="x">\n'],
      resolvedTheme: "dark",
    });

    expect(line).toBe("&lt;unsafe attr=&quot;x&quot;&gt;");
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
