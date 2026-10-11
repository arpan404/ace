import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { createWritingCli } from "./source-control-cli.ts";
import {
  writingFixture as fixture,
  writingThreadId as threadId,
} from "./source-control-test-support.ts";

test.each(["claude", "codex"] as const)(
  "%s drafts from selected bytes and conventions without committing or staging excluded files",
  async (provider) => {
    const f = await fixture(provider);
    try {
      const index = f.git("diff", "--cached");
      const result = await f.generate();
      expect(result.result).toMatchObject({
        kind: "draft",
        draft: { subject: "fix: update selected behavior", body: "Explain the selected change." },
        context: { paths: ["selected.txt"], head: f.initialHead },
      });
      const prompt = await readFile(join(f.root, "prompt.txt"), "utf8");
      expect(prompt).toContain("after selected");
      expect(prompt).not.toContain("private excluded change");
      expect(prompt).toContain("Use imperative subjects");
      expect(prompt).toContain("fix: initial behavior");
      expect(prompt).toContain("Use conventional commits");
      expect(f.git("rev-parse", "HEAD")).toBe(f.initialHead);
      expect(f.git("diff", "--cached")).toBe(index);
      expect(await readFile(join(f.repo, "excluded.txt"), "utf8")).toBe(
        "private excluded change\n",
      );
      const args = JSON.parse(await readFile(join(f.root, "args.json"), "utf8"));
      expect(args).toContain("test-model");
      expect(args).toContain(provider === "claude" ? "--tools" : "read-only");
    } finally {
      await f.close();
    }
  },
);

test("PR drafts use committed branch/base changes, templates and thread intent rather than the working tree", async () => {
  const f = await fixture();
  try {
    f.git("add", "selected.txt");
    f.git("commit", "-m", "fix: selected behavior");
    await mkdir(join(f.repo, ".github"));
    await writeFile(join(f.repo, ".github/PULL_REQUEST_TEMPLATE.md"), "## Intent\n## Testing\n");
    const selection = { kind: "pr" as const, branch: "feature", base: "main" };
    const context = await f.runtime.draftContext(threadId, selection);
    expect(context.paths).toEqual(["excluded.txt", "selected.txt"]);
    expect(context.conventions).toContainEqual({
      path: ".github/PULL_REQUEST_TEMPLATE.md",
      text: "## Intent\n## Testing\n",
    });
    expect(context.patch).not.toContain("uncommitted only");
    await writeFile(join(f.repo, "selected.txt"), "uncommitted only\n");
    const result = await f.runtime.read({
      type: "workspace.request",
      requestId: "pr",
      operation: {
        op: "git.draft.generate",
        threadId,
        input: {
          generationId: "pr-generation",
          selection,
          fingerprint: context.fingerprint,
          provider: "claude",
          preference: "",
        },
      },
    });
    expect(result.result.kind).toBe("draft");
    const prompt = await readFile(join(f.root, "prompt.txt"), "utf8");
    expect(prompt).toContain("Explain selected behavior");
    expect(prompt).not.toContain("uncommitted only");
  } finally {
    await f.close();
  }
});

test.each(["remote-only", "divergent-local"])(
  "PR drafting compares against the recorded remote base with a %s branch",
  async (kind) => {
    const f = await fixture();
    try {
      f.git("add", "selected.txt");
      f.git("commit", "-m", "fix: selected behavior");
      f.git("remote", "add", "origin", "https://github.com/acme/repo.git");
      f.git("update-ref", "refs/remotes/origin/release", f.initialHead);
      if (kind === "divergent-local") f.git("branch", "release", "feature");
      const selection = {
        kind: "pr" as const,
        branch: "feature",
        base: "release",
        baseRef: "refs/remotes/origin/release",
      };
      const context = await f.runtime.draftContext(threadId, selection);
      expect(context.base).toBe(f.initialHead);
      expect(context.paths).toEqual(["excluded.txt", "selected.txt"]);
      const result = await f.runtime.read({
        type: "workspace.request",
        requestId: "remote-base",
        operation: {
          op: "git.draft.generate",
          threadId,
          input: {
            generationId: "remote-base",
            selection,
            fingerprint: context.fingerprint,
            provider: "claude",
            preference: "",
          },
        },
      });
      expect(result.result.kind).toBe("draft");
      expect(await readFile(join(f.root, "prompt.txt"), "utf8")).toContain("after selected");
    } finally {
      await f.close();
    }
  },
);

test.each(["refs/remotes/upstream/main", "upstream/main"])(
  "a fork draft with comparison base %s is refused before starting the provider CLI",
  async (baseRef) => {
    const f = await fixture();
    try {
      f.git("remote", "add", "origin", "https://github.com/person/fork.git");
      f.git("remote", "add", "upstream", "https://github.com/acme/repo.git");
      f.git("update-ref", "refs/remotes/origin/main", f.initialHead);
      await writeFile(join(f.repo, "upstream.txt"), "Upstream change X\n");
      f.git("add", "upstream.txt");
      f.git("commit", "-m", "Upstream change X");
      f.git("update-ref", "refs/remotes/upstream/main", "HEAD");
      f.git("add", "selected.txt");
      f.git("commit", "-m", "Feature change Y");
      expect(f.git("diff", "--name-only", "upstream/main...feature")).toBe("selected.txt");
      expect(f.git("diff", "--name-only", "origin/main...feature")).toContain("upstream.txt");
      const selection = { kind: "pr" as const, branch: "feature", base: "main", baseRef };
      await expect(f.runtime.draftContext(threadId, selection)).rejects.toMatchObject({
        code: "pr_base_mismatch",
      });
      await expect(
        f.runtime.read({
          type: "workspace.request",
          requestId: "fork-base",
          operation: {
            op: "git.draft.generate",
            threadId,
            input: {
              generationId: "fork-base",
              selection,
              fingerprint: "0".repeat(64),
              provider: "claude",
              preference: "",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "pr_base_mismatch" });
      expect(existsSync(join(f.root, "prompt.txt"))).toBe(false);
      // A comparison on the destination includes both X and Y and remains usable.
      const context = await f.runtime.draftContext(threadId, {
        ...selection,
        baseRef: "refs/remotes/origin/main",
      });
      expect(context.paths).toContain("upstream.txt");
      expect(context.paths).toContain("selected.txt");
    } finally {
      await f.close();
    }
  },
);

test.each(["move", "fail", "invalid"])(
  "a %s result returns a fixed failure and leaves Git unchanged",
  async (behavior) => {
    const f = await fixture("claude", behavior);
    try {
      await expect(f.generate()).rejects.toThrow(
        behavior === "move"
          ? "draft_changes_moved"
          : behavior === "fail"
            ? "draft_provider_failed"
            : "draft_invalid_output",
      );
      expect(f.git("rev-parse", "HEAD")).toBe(f.initialHead);
      expect(f.git("diff", "--cached", "--name-only")).toBe("excluded.txt");
    } finally {
      await f.close();
    }
  },
);

test("cancelling a waiting CLI stops it and discards its result", async () => {
  const f = await fixture("claude", "wait");
  try {
    const controller = new AbortController();
    // Wait for the actual child to receive input, without sleep synchronization.
    const { watch } = await import("node:fs");
    const received = new Promise<void>((resolve) => {
      const watcher = watch(f.root, (_event, file) => {
        if (file === "prompt.txt") {
          watcher.close();
          resolve();
        }
      });
    });
    const pending = f.generate(controller.signal);
    await received;
    controller.abort();
    await expect(pending).rejects.toThrow("draft_cancelled");
    expect(f.git("rev-parse", "HEAD")).toBe(f.initialHead);
  } finally {
    await f.close();
  }
});

test("a reviewed commit draft refuses changed file bytes even when HEAD stays unchanged", async () => {
  const f = await fixture();
  try {
    const context = await f.context();
    await writeFile(join(f.repo, "selected.txt"), "new unseen change\n");
    const result = await f.runtime.execute(
      Command.parse({
        id: "commit",
        deviceId: "test",
        payload: {
          type: "git.commit",
          threadId,
          message: "Reviewed draft",
          paths: f.selection.paths,
          expectedHead: context.head,
          draftFingerprint: context.fingerprint,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: "git_head_moved" });
    expect(f.git("rev-parse", "HEAD")).toBe(f.initialHead);
    expect(f.git("diff", "--cached", "--name-only")).toBe("excluded.txt");
  } finally {
    await f.close();
  }
});

test("an unavailable CLI sends no generation prompt", async () => {
  const write = createWritingCli({
    discover: async () => ({ installed: false, auth: "unknown", loginHint: "Install CLI" }),
  });
  await expect(
    write(
      {
        generationId: "unavailable",
        selection: { kind: "commit", paths: ["x"] },
        fingerprint: "0".repeat(64),
        provider: "codex",
        preference: "",
      },
      {
        fingerprint: "0".repeat(64),
        head: null,
        base: null,
        paths: ["x"],
        patch: "",
        truncated: false,
        conventions: [],
        recentCommits: "",
      },
      "",
      new AbortController().signal,
    ),
  ).rejects.toThrow("draft_provider_unavailable");
});

test("submitting a reviewed draft commits the edited message and only its unchanged selection", async () => {
  const f = await fixture();
  try {
    const generated = await f.generate();
    if (generated.result.kind !== "draft") throw new Error("Expected draft");
    const result = await f.runtime.execute(
      Command.parse({
        id: "reviewed-commit",
        deviceId: "test",
        payload: {
          type: "git.commit",
          threadId,
          message: "fix: my reviewed wording\n\nMy edited explanation.",
          paths: f.selection.paths,
          expectedHead: generated.result.context.head,
          draftFingerprint: generated.result.context.fingerprint,
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(f.git("log", "-1", "--format=%B")).toBe(
      "fix: my reviewed wording\n\nMy edited explanation.",
    );
    expect(f.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("selected.txt");
    expect(f.git("show", "HEAD:selected.txt")).toBe("after selected");
    expect(f.git("show", "HEAD:excluded.txt")).toBe("private before");
    expect(f.git("diff", "--cached", "--name-only")).toBe("excluded.txt");
  } finally {
    await f.close();
  }
});

test("new files, binary bytes and both sides of a rename participate in the reviewed commit revision", async () => {
  const f = await fixture();
  try {
    f.git("mv", "selected.txt", "renamed.txt");
    await writeFile(join(f.repo, "literal*.txt"), "new literal file\n");
    await writeFile(join(f.repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const selection = {
      kind: "commit" as const,
      paths: ["selected.txt", "renamed.txt", "literal*.txt", "binary.dat"],
    };
    const context = await f.runtime.draftContext(threadId, selection);
    expect(context.paths).toEqual(["binary.dat", "literal*.txt", "renamed.txt", "selected.txt"]);
    expect(context.patch).toContain("new literal file");
    expect(context.patch).toContain("Binary files");
    const index = f.git("diff", "--cached");
    await writeFile(join(f.repo, "binary.dat"), Buffer.from([0, 9, 8, 7]));
    expect((await f.runtime.draftContext(threadId, selection)).fingerprint).not.toBe(
      context.fingerprint,
    );
    expect(f.git("diff", "--cached")).toBe(index);
  } finally {
    await f.close();
  }
});
