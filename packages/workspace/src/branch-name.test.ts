import { expect, test } from "vitest";
import {
  generatedBranchSlug,
  worktreeBranchName,
  worktreeBranchSlugMaxChars,
} from "./branch-name.ts";

test("model slugs stay concise and git-safe", () => {
  expect(generatedBranchSlug("fix-reconnect")).toBe("fix-reconnect");
  expect(generatedBranchSlug("  Fix Reconnect Behavior\n")).toBe("fix-reconnect-behavior");
  expect(generatedBranchSlug("ace/fix-reconnect")).toBe("fix-reconnect");
  expect(generatedBranchSlug('"fix-reconnect."')).toBe("fix-reconnect");
  expect(generatedBranchSlug("Branch: fix-reconnect")).toBe("fix-reconnect");
});

test("model slugs are capped to four words and the length budget", () => {
  expect(generatedBranchSlug("fix the reconnect behavior quickly today")).toBe(
    "fix-the-reconnect-behavior",
  );
  const long = generatedBranchSlug("supercalifragilisticexpialidocious reconnect behavior fix");
  expect(long).toBeDefined();
  expect(long!.length).toBeLessThanOrEqual(worktreeBranchSlugMaxChars);
  expect(`ace/${long}`.length).toBeLessThanOrEqual(4 + worktreeBranchSlugMaxChars);
  // Collision suffix stays within the 40-character branch cap.
  expect(worktreeBranchName(long!, 256).length).toBeLessThanOrEqual(40);
});

test("unusable model replies fall back to the title slug", () => {
  expect(generatedBranchSlug("")).toBeUndefined();
  expect(generatedBranchSlug("   \n  ")).toBeUndefined();
  expect(generatedBranchSlug("New thread")).toBeUndefined();
  expect(generatedBranchSlug("!!!")).toBeUndefined();
  expect(generatedBranchSlug("ace/")).toBeUndefined();
});

test("generated slugs produce branch names within the total budget", () => {
  for (const slug of ["fix-reconnect", "fix-login-timeout", "a-b-c-d"] as const) {
    expect(worktreeBranchName(slug, 1)).toBe(`ace/${slug}`);
    expect(worktreeBranchName(slug, 2)).toBe(`ace/${slug}-2`);
    expect(worktreeBranchName(slug, 256).length).toBeLessThanOrEqual(40);
  }
});
