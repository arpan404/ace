import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { Command, Thread, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { createWritingCli } from "./source-control-cli.ts";

const threadId = ThreadId.parse("writing-thread");
async function fixture(provider: "claude" | "codex" = "claude", behavior = "success") {
  const root = await mkdtemp(join(tmpdir(), "ace-writing-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "selected.txt"), "before\n");
  await writeFile(join(repo, "excluded.txt"), "private before\n");
  await writeFile(join(repo, "AGENTS.md"), "Use imperative subjects and explain intent.\n");
  git("add", ".");
  git("commit", "-m", "fix: initial behavior");
  const initialHead = git("rev-parse", "HEAD");
  git("switch", "-c", "feature");
  await writeFile(join(repo, "selected.txt"), "after selected\n");
  await writeFile(join(repo, "excluded.txt"), "private excluded change\n");
  git("add", "excluded.txt");
  const cli = join(root, "provider.mjs");
  await writeFile(
    cli,
    `#!/usr/bin/env node
import fs from 'node:fs';
let prompt=''; for await (const bytes of process.stdin) prompt+=bytes;
fs.writeFileSync(${JSON.stringify(join(root, "prompt.txt"))}, prompt);
fs.writeFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(behavior)} === 'wait') { setInterval(()=>{},1000); await new Promise(()=>{}); }
if (${JSON.stringify(behavior)} === 'move') fs.writeFileSync(${JSON.stringify(join(repo, "selected.txt"))}, 'changed while generating\\n');
if (${JSON.stringify(behavior)} === 'fail') { console.error('Authorization: Bearer private-diagnostic'); process.exit(1); }
const draft = JSON.stringify({subject:'fix: update selected behavior',body:'Explain the selected change.'});
if (${JSON.stringify(behavior)} === 'invalid') console.log(JSON.stringify({result:'not valid JSON'}));
else if (${JSON.stringify(provider)} === 'claude') console.log(JSON.stringify({result:draft}));
else { console.log(JSON.stringify({type:'unknown.future',item:'future-shape',other:{retained:true}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:draft}})); console.log(JSON.stringify({type:'turn.completed'})); }
`,
  );
  await chmod(cli, 0o700);
  const store = new Store(join(root, "store.sqlite"));
  const workspaceId = store.createWorkspace(repo, "Repo");
  const thread = Thread.parse({
    id: threadId,
    workspaceId,
    title: "Explain selected behavior",
    provider,
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(threadId, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1, {
    writingCli: createWritingCli({
      discover: async () => ({ path: cli, installed: true, auth: "logged_in", loginHint: "" }),
      tempRoot: root,
    }),
  });
  const selection = { kind: "commit" as const, paths: ["selected.txt"] };
  const context = () => runtime.draftContext(threadId, selection);
  const generate = async (signal?: AbortSignal) =>
    runtime.read(
      {
        type: "workspace.request",
        requestId: "generate",
        operation: {
          op: "git.draft.generate",
          threadId,
          input: {
            generationId: "generation",
            selection,
            fingerprint: (await context()).fingerprint,
            provider,
            model: "test-model",
            preference: "Use conventional commits",
          },
        },
      },
      signal,
    );
  return {
    root,
    repo,
    store,
    runtime,
    git,
    initialHead,
    selection,
    context,
    generate,
    close: async () => {
      await runtime.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

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

test("a moved PR base refuses publication of the old summary before contacting the forge", async () => {
  const f = await fixture();
  try {
    f.git("add", "selected.txt");
    f.git("commit", "-m", "fix: selected behavior");
    const context = await f.runtime.draftContext(threadId, {
      kind: "pr",
      branch: "feature",
      base: "main",
    });
    f.git("branch", "-f", "main", "feature");
    const result = await f.runtime.execute(
      Command.parse({
        id: "moved-pr",
        deviceId: "test",
        payload: {
          type: "forge.pr.create",
          threadId,
          repository: { forge: "github", host: "github.com", owner: "acme", name: "repo" },
          draftFingerprint: context.fingerprint,
          input: {
            branch: "feature",
            base: "main",
            title: "Reviewed title",
            summary: "Reviewed summary",
            template: { title: "{{title}}", body: "{{summary}}" },
            draft: false,
          },
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: "git_invalid_argument" });
    expect(f.store.getThread(threadId)?.details?.linkedPr).toBeUndefined();
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
