import { expect, test, vi } from "vitest";
import { Store } from "./store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchPrompt, generatedBranchName, ThreadTitles } from "./thread-titles.ts";
import { ThreadId } from "@ace/protocol";

test("branch prompts ask for a compact slug without the prefix", () => {
  const prompt = branchPrompt([{ type: "text", text: "Fix reconnect behavior" }]);
  expect(prompt).toContain("2-4");
  expect(prompt).toContain("fix-reconnect");
  expect(prompt).toContain("Fix reconnect behavior");
  expect(prompt).toContain("untrusted");
});

test("branch replies are sanitized to concise slugs", () => {
  expect(generatedBranchName("fix-reconnect")).toBe("fix-reconnect");
  expect(generatedBranchName("ace/fix-reconnect")).toBe("fix-reconnect");
  expect(generatedBranchName("Fix the reconnect behavior quickly today")).toBe(
    "fix-the-reconnect-behavior",
  );
  expect(generatedBranchName("New thread")).toBeUndefined();
  expect(generatedBranchName("")).toBeUndefined();
});

test("worktree threads generate a branch slug alongside the title", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-titles-"));
  const store = new Store(join(home, "events.sqlite"));
  try {
    const prompts: string[] = [];
    const slugs: string[] = [];
    const titles = new ThreadTitles({
      store,
      now: () => 1,
      generate: async (prompt) => {
        prompts.push(prompt);
        return prompt.includes("branch slug") ? "fix-reconnect" : "Fix reconnect";
      },
      shouldGenerateBranch: () => true,
      onBranchSlug: (id, slug) => {
        slugs.push(`${id}:${slug}`);
      },
    });
    const id = ThreadId.parse("11111111-1111-4111-8111-111111111111");
    titles.namingPrompt(id, [{ type: "text", text: "Fix reconnect" }]);
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await vi.waitFor(() => expect(slugs).toEqual([`${id}:fix-reconnect`]));
    titles.close();
  } finally {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-worktree threads keep a single title call", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-titles-"));
  const store = new Store(join(home, "events.sqlite"));
  try {
    const prompts: string[] = [];
    const titles = new ThreadTitles({
      store,
      now: () => 1,
      generate: async (prompt) => {
        prompts.push(prompt);
        return "Fix reconnect";
      },
    });
    const id = ThreadId.parse("22222222-2222-4222-8222-222222222222");
    titles.namingPrompt(id, [{ type: "text", text: "Fix reconnect" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("branch slug");
    titles.close();
  } finally {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("branch failures never surface and keep the title fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-titles-"));
  const store = new Store(join(home, "events.sqlite"));
  try {
    const failures: unknown[] = [];
    const titles = new ThreadTitles({
      store,
      now: () => 1,
      generate: async (prompt) => {
        if (prompt.includes("branch slug")) throw new Error("utility_unavailable");
        return "Fix reconnect";
      },
      shouldGenerateBranch: () => true,
      onFailure: (_id, error) => {
        failures.push(error);
      },
    });
    const id = ThreadId.parse("33333333-3333-4333-8333-333333333333");
    titles.namingPrompt(id, [{ type: "text", text: "Fix reconnect" }]);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ message: "utility_unavailable" });
    titles.close();
  } finally {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
