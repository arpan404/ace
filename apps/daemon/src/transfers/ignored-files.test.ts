import { describe, expect, it } from "vitest";
import { ignoredSelection, neverPlaced, staysBehind } from "./ignored-files.ts";

describe("which ignored files travel", () => {
  it("keeps local files such as .env and editor config", () => {
    expect(ignoredSelection([".env", "config/local.json", ".vscode/", "secrets/"])).toEqual([
      ".env",
      "config/local.json",
      ".vscode/",
      "secrets/",
    ]);
  });

  it("leaves dependency and cache folders behind wherever they sit", () => {
    expect(
      ignoredSelection([
        "node_modules/",
        "packages/web/node_modules/",
        ".venv/",
        "venv/",
        "src/__pycache__/",
        ".pnpm-store/",
        ".yarn/cache/",
        ".gradle/",
        "apps/site/.next/",
        ".turbo/",
        ".cache/",
        "target/",
        "target/debug/build.log",
        ".env.local",
      ]),
    ).toEqual([".env.local"]);
  });

  it("only treats a name as rebuilt when it is a folder", () => {
    expect(ignoredSelection(["notes/target", "cache.txt"])).toEqual(["notes/target", "cache.txt"]);
    expect(staysBehind({ path: "target", kind: "file" })).toBe(false);
  });

  it("keeps .yarn's own config but not its cache", () => {
    expect(ignoredSelection([".yarn/cache/", ".yarn/install-state.gz"])).toEqual([
      ".yarn/install-state.gz",
    ]);
  });

  it("leaves nested Git repositories behind", () => {
    expect(staysBehind({ path: "vendor/lib", kind: "directory", names: [".git", "src"] })).toBe(
      true,
    );
    expect(staysBehind({ path: "vendor/lib", kind: "directory", names: ["src"] })).toBe(false);
  });

  it("never places anything into a repository's .git, whatever the sender sent", () => {
    expect(neverPlaced(".git/hooks/pre-commit")).toBe(true);
    expect(neverPlaced("vendor/.GIT/config")).toBe(true);
    expect(neverPlaced(".gitignore")).toBe(false);
    expect(neverPlaced(".env")).toBe(false);
  });
});
