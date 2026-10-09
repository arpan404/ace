import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentId, ThreadId } from "@ace/protocol";
import { openHistory, openArchiveReader } from "@ace/history-import";
import { Store } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("cancelled engine publication rolls back history and sequences before a later successful publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-publication-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"),
    cwd = "/repo";
  await mkdir(join(home, "sessions/2026/01/01"), { recursive: true });
  const output = "result".repeat(20000),
    opaque = JSON.stringify({ type: "future-record", data: "x".repeat(3 * 1024 * 1024) });
  const records = [
    { type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the working directory" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "c",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      },
    },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c", output } },
  ];
  await writeFile(
    join(home, "sessions/2026/01/01/rollout.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n" + opaque + "\n",
  );
  const indexPath = join(root, "history/index.sqlite");
  const history = await openHistory({
    indexPath,
    instances: [{ id: "account", provider: "codex", homeDir: home }],
  });
  cleanup.unshift(() => history.close());
  const store = new Store(join(root, "events.sqlite"));
  cleanup.unshift(async () => store.close());
  const workspaceId = store.createWorkspace(cwd, "Repo");
  await history.scan();
  const source = (await history.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing source");
  const threadId = ThreadId.parse("imported"),
    agentId = AgentId.parse("root");
  await history.importSession({ sourceId: source.id, threadId, workspaceId, agentId, at: 123 });
  const reader = openArchiveReader(indexPath, threadId);
  cleanup.unshift(async () => reader.close());
  let checks = 0;
  expect(() => store.installHistory(reader, 123, () => ++checks === 4)).toThrow("cancelled");
  expect(store.getThread(threadId)).toBeUndefined();
  expect(store.headSeq()).toBe(0);
  expect(store.readEvents({ afterSeq: 0, limit: 100 })).toEqual([]);
  store.installHistory(reader, 123, () => false);
  expect(store.getThread(threadId)?.imported?.instanceId).toBe("account");
  expect(store.getThread(threadId)).toMatchObject({
    status: { state: "done" },
    settledAt: 123,
    settledReason: "manual",
    unread: false,
  });
  // Before this upgrade old imports had no settlement metadata and could be labelled new.
  store.atomic((db) =>
    db
      .prepare(
        "UPDATE threads SET status='{\"state\":\"new\"}', client=json_remove(client,'$.settledAt','$.settledReason') WHERE id=?",
      )
      .run(threadId),
  );
  const { Engine, AdapterRegistry } = await import("@ace/daemon");
  const migrated = new Engine(store, {
    registry: new AdapterRegistry(),
    clock: { now: () => 124, setTimer: () => () => {} },
  });
  await migrated.ready();
  expect(store.getThread(threadId)).toMatchObject({ status: { state: "done" }, settledAt: 123 });
  await migrated.close();
  const snapshot = store.snapshotThread(threadId);
  const call = Object.values(snapshot.items).find((i) => i.type === "tool_call");
  if (call?.type !== "tool_call" || call.call.detail.kind !== "shell" || !call.call.detail.output)
    throw new Error("Missing shell output");
  const streamId = call.call.detail.output.streamId;
  expect(
    Buffer.from(
      store.readOutput(call.call.detail.output.streamId, 0, 256 * 1024).bytes,
      "base64",
    ).toString(),
  ).toBe(output);
  const notice = Object.values(snapshot.items).find(
    (i) => i.type === "notice" && i.text.includes("oversized"),
  );
  const raw = notice?.type === "notice" ? notice.raw[0] : undefined;
  if (!raw || !("blobRef" in raw)) throw new Error("Missing native blob");
  const hash = createHash("sha256");
  for (let offset = 0; offset < raw.size; offset += 256 * 1024)
    hash.update(store.readHistoryBlob(threadId, raw.blobRef, offset, 256 * 1024).bytes);
  expect(hash.digest("hex")).toBe(createHash("sha256").update(opaque).digest("hex"));
  expect(() => store.readHistoryBlob(ThreadId.parse("other-thread"), raw.blobRef, 0, 1)).toThrow();
  store.deleteThread(threadId);
  expect(() => store.readOutput(streamId, 0, 1)).toThrow();
  expect(() => store.readHistoryBlob(threadId, raw.blobRef, 0, 1)).toThrow();
});
