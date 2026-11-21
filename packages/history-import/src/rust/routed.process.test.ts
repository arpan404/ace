import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openHistory } from "../index.ts";
import {
  claudeRecords,
  cwd,
  init,
  jsonl,
  nativeId,
  roomySnapshots,
  text,
} from "../test-support.ts";
import { findHistoryBinary } from "./reader-binary.ts";

const binary = findHistoryBinary();
// Idle readers retire at once, so an import restarts ace-history and a close finds the
// TypeScript reader gone.
const delay = (callback: () => void) => {
  const timer = setTimeout(callback, 1);
  return () => clearTimeout(timer);
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
});

/** A Claude Code home, read by ace-history, and an OpenCode home, read by the TypeScript reader. */
async function homes() {
  const root = await mkdtemp(join(tmpdir(), "ace-history-routed-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, "claude");
  await jsonl(join(claude, "projects/p", `${nativeId}.jsonl`), claudeRecords("claude prompt"));
  const opencode = join(root, "opencode");
  const id = "ses_opencode";
  await mkdir(join(opencode, "storage/session/p"), { recursive: true });
  await writeFile(
    join(opencode, "storage/session/p", `${id}.json`),
    JSON.stringify({
      id,
      directory: cwd,
      title: "OpenCode session",
      time: { created: 1, updated: 2 },
    }),
  );
  await mkdir(join(opencode, "storage/message", id), { recursive: true });
  await writeFile(
    join(opencode, "storage/message", id, "msg_1.json"),
    JSON.stringify({ id: "msg_1", sessionID: id, role: "user", time: { created: 1 } }),
  );
  await mkdir(join(opencode, "storage/part/msg_1"), { recursive: true });
  await writeFile(
    join(opencode, "storage/part/msg_1/prt_1.json"),
    JSON.stringify({ id: "prt_1", messageID: "msg_1", type: "text", text: "opencode prompt" }),
  );
  return {
    root,
    instances: [
      { id: "claude-home", provider: "claude" as const, homeDir: claude },
      { id: "opencode-home", provider: "opencode" as const, homeDir: opencode },
    ],
  };
}

test.skipIf(!binary)(
  "each provider's sessions are listed and imported by the reader that owns them",
  async () => {
    const { root, instances } = await homes();
    const service = await openHistory(
      { indexPath: join(root, "ace/index.sqlite"), instances, snapshot: roomySnapshots },
      undefined,
      { readerBinary: binary ?? null },
    );
    cleanup.unshift(() => service.close());
    const scan = await service.scan();
    // One count across both readers: the Claude transcript and the OpenCode session file.
    expect(scan.files).toBe(2);
    const sessions = (await service.list({ type: "history.list", cwd })).sessions;
    expect(sessions.map((s) => s.provider).toSorted()).toEqual(["claude", "opencode"]);
    for (const [index, session] of sessions.entries()) {
      const target = init(session.id, `thread-${index}`);
      await service.importSession(target);
      const items = (await service.itemsPage({ threadId: target.threadId })).items;
      expect(text(items)).toContain(`${session.provider} prompt`);
    }
  },
  30_000,
);

test.skipIf(!binary)(
  "closing after both readers retired while idle ends cleanly",
  async () => {
    const { root, instances } = await homes();
    const service = await openHistory(
      { indexPath: join(root, "ace/index.sqlite"), instances, snapshot: roomySnapshots },
      undefined,
      { readerBinary: binary ?? null, delay },
    );
    await service.scan();
    const source = (await service.list({ type: "history.list", cwd })).sessions.find(
      (s) => s.provider === "claude",
    );
    if (!source) throw new Error("Missing Claude session");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await service.importSession(init(source.id));
    await expect(service.close()).resolves.toBeUndefined();
  },
  30_000,
);
