// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Command, ThreadId, WorkspaceId } from "@ace/protocol";
import { ReviewService } from "@ace/review";
import { expect, test } from "vitest";
import { LocalStore } from "../store.ts";
import { record, saveDraft, type ReviewDraft } from "./drafts.ts";
import { applySuggestion } from "./review-actions.ts";

const exec = promisify(execFile);
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "ace-web-review-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.name", "Review test");
  await git("config", "user.email", "review@example.invalid");
  await writeFile(join(root, "file.ts"), "header\nconst a = 0;\nfooter\n");
  await git("add", "file.ts");
  await git("commit", "-qm", "base");
  let serial = 0;
  const service = new ReviewService({
    path: join(directory, "review.sqlite"),
    now: () => 1,
    id: () => `review-${++serial}`,
  });
  const client = {
    command: async (payload: unknown) =>
      service.handle(
        Command.parse({ id: `command-${++serial}`, deviceId: "device", payload }),
        root,
      ),
  };
  const thread = { id: ThreadId.parse("thread"), workspaceId: WorkspaceId.parse("workspace") };
  const store = new LocalStore<readonly ReviewDraft[]>([]);
  return {
    root,
    client,
    thread,
    store,
    write: (text: string) => writeFile(join(root, "file.ts"), text),
    read: () => readFile(join(root, "file.ts"), "utf8"),
    close: async () => {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const selected = { before: ["header"], lines: ["const a = 1;"], after: ["footer"] };
function draft(f: Awaited<ReturnType<typeof repository>>, suggestion?: string) {
  saveDraft(f.store, {
    threadId: f.thread.id,
    file: "file.ts",
    side: "new",
    line: 2,
    text: "Change a",
    fingerprint: selected,
    ...(suggestion === undefined ? {} : { suggestion }),
    createdAt: 1,
  });
}

test("a historical suggestion after an insertion refuses to overwrite a different current line", async () => {
  const f = await repository();
  try {
    const current = "const b = 2;\nheader\nconst a = 1;\nfooter\n";
    await f.write(current);
    draft(f, "const a = 3;");
    await applySuggestion(f.client, f.store, f.thread, f.store.get()[0]?.key ?? "");
    expect(await f.read()).toBe(current);
    expect(f.store.get()[0]).toMatchObject({ state: "draft", error: expect.any(String) });
    const sessions = await f.client.command({ type: "review.list" });
    const session = sessions.review?.sessions?.[0];
    expect(
      (await f.client.command({ type: "review.list", sessionId: session?.id })).review?.comments,
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

test("recording a historical comment rejects an excerpt that differs from its displayed selection", async () => {
  const f = await repository();
  try {
    await f.write("const b = 2;\nheader\nconst a = 1;\nfooter\n");
    draft(f);
    await expect(record(f.client, f.store, f.thread, f.store.get())).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 30000);

test("a matching displayed selection is recorded against an immutable snapshot and applies only its selected text", async () => {
  const f = await repository();
  try {
    await f.write("header\nconst a = 1;\nfooter\n");
    draft(f, "const a = 3;");
    await record(f.client, f.store, f.thread, f.store.get());
    const held = f.store.get()[0];
    const listed = await f.client.command({ type: "review.list", sessionId: held?.sessionId });
    expect(listed.review?.comments?.[0]?.anchor.fingerprint.lines).toEqual(["const a = 1;"]);
    expect(listed.review?.comments?.[0]?.anchor.revision.kind).toBe("checkpoint");
    await applySuggestion(f.client, f.store, f.thread, held?.key ?? "");
    expect(await f.read()).toBe("header\nconst a = 3;\nfooter\n");
    expect(f.store.get()[0]?.state).toBe("resolved");
  } finally {
    await f.close();
  }
}, 30000);

test("identical selected text with different displayed context is refused without changing the checkout", async () => {
  const f = await repository();
  try {
    const current = "different header\nconst a = 1;\nfooter\n";
    await f.write(current);
    draft(f, "const a = 3;");
    await applySuggestion(f.client, f.store, f.thread, f.store.get()[0]?.key ?? "");
    expect(await f.read()).toBe(current);
    expect(f.store.get()[0]).toMatchObject({ state: "draft", error: expect.any(String) });
  } finally {
    await f.close();
  }
}, 30000);
