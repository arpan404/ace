import { describe, expect, it } from "vitest";
import { forgeErrorText } from "./forge-error-copy.ts";

const readFailures = [
  "forge_cli",
  "forge_forbidden",
  "forge_not_found",
  "forge_rate_limit",
  "forge_unsupported",
  "forge_offline",
  "forge_invalid_data",
  "forge_limit",
  "forge_read_failed",
  "forge_write_refused",
  "pr_unreadable",
];

describe("Git host read failures", () => {
  it.each(["gitlab", "origin", "bitbucket", "gitea", "forgejo", "gitbucket"] as const)(
    "never name GitHub or gh for %s",
    (forge) => {
      for (const code of readFailures) {
        const text = forgeErrorText(code, forge);
        expect(text).not.toMatch(/GitHub|`gh`/);
      }
    },
  );

  it("tell GitLab users to sign in with glab", () => {
    expect(forgeErrorText("forge_cli", "gitlab")).toContain("`glab auth login`");
    expect(forgeErrorText("forge_cli", "origin")).toContain("`origin auth login`");
  });

  it("tell Bitbucket users to sign bkt in to Bitbucket Cloud, not a Data Center server", () => {
    expect(forgeErrorText("forge_cli", "bitbucket")).toContain(
      "`bkt auth login https://bitbucket.org --kind cloud --web`",
    );
  });

  it("send providers without a CLI to the host's website", () => {
    expect(forgeErrorText("forge_cli", "gitea")).toBe(
      "ace can't read Gitea yet: open it on Gitea.",
    );
  });

  it("keep GitHub's own sentences", () => {
    expect(forgeErrorText("forge_cli", "github")).toContain("`gh auth login`");
    expect(forgeErrorText("forge_cli", undefined)).toContain("`gh auth login`");
  });

  it("leave codes that aren't about the host unchanged", () => {
    expect(forgeErrorText("offline", "gitlab")).toBe(forgeErrorText("offline", "github"));
  });
});
