import { mkdir, readdir, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { object, readJsonLines } from "@ace/native-session";
import { providerHomes } from "./parity-providers.ts";
import { claudeRecords, codexRecords, cwd, jsonl, nativeId, otherId } from "../test-support.ts";

const fixtures = new URL("../../../../fixtures/", import.meta.url).pathname;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Claude transcripts derived from the recorded CLI fixtures: their user and assistant messages. */
async function recordedClaude(project: string): Promise<number> {
  const dir = join(fixtures, "claude/2.1.286");
  let count = 0;
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).toSorted()) {
    const records: unknown[] = [];
    for await (const record of readJsonLines(fixtures, join(dir, name))) {
      if (!("value" in record)) continue;
      const data = object(object(record.value).data);
      if (data.type === "assistant" || data.type === "user")
        records.push({
          ...data,
          sessionId: id(100 + count),
          cwd,
          timestamp: "2026-02-01T00:00:00.000Z",
        });
    }
    if (records.length) await jsonl(join(project, `${id(100 + count)}.jsonl`), records);
    count++;
  }
  return count;
}

/**
 * One Claude Code, one Codex and one Cursor home covering what the readers distinguish: plain
 * sessions, sidechains, compactions, tool calls with results, images, a record over the decode
 * limit, a malformed line, a live partial tail, provider titles, a Codex state database and
 * session index, a fork that points at another file and a compressed rollout. Synthetic text.
 */
export async function parityHomes(root: string) {
  const claude = join(root, "claude");
  const project = join(claude, "projects/p");
  await jsonl(join(project, `${nativeId}.jsonl`), claudeRecords("Fix the reconnect retries"));
  await jsonl(join(project, `${nativeId}/subagents/agent-1.jsonl`), [
    {
      type: "user",
      sessionId: nativeId,
      isSidechain: true,
      cwd,
      message: { role: "user", content: "Look around" },
    },
    {
      type: "assistant",
      sessionId: nativeId,
      isSidechain: true,
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "Found it" }] },
    },
  ]);
  await jsonl(
    join(project, `${otherId}.jsonl`),
    [
      { type: "summary", summary: "Release checklist" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: otherId,
        cwd,
        timestamp: "2026-01-02T00:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>x</system-reminder>Ship it" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "u2",
        parentUuid: "u1",
        sessionId: otherId,
        cwd,
        message: {
          role: "assistant",
          model: "claude-model",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
            {
              type: "tool_use",
              id: "t2",
              name: "Edit",
              input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u3",
        parentUuid: "u2",
        sessionId: otherId,
        cwd,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "total 0\n" + "line\n".repeat(2000),
            },
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [{ type: "text", text: "edited" }],
              is_error: true,
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "abandoned",
        parentUuid: "u2",
        sessionId: otherId,
        cwd,
        message: { role: "user", content: "a branch that was rewound" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        parentUuid: "u3",
        sessionId: otherId,
        cwd,
        compactMetadata: { preTokens: 1200, postTokens: 80 },
      },
      {
        type: "user",
        uuid: "s1",
        parentUuid: "b1",
        isCompactSummary: true,
        sessionId: otherId,
        cwd,
        message: { role: "user", content: "Summary of the work so far" },
      },
      {
        type: "assistant",
        uuid: "u4",
        parentUuid: "s1",
        sessionId: otherId,
        cwd,
        message: { role: "assistant", content: [{ type: "text", text: "y".repeat(9000) }] },
      },
      { type: "future-record", uuid: "f1", parentUuid: "u4", payload: { kept: true } },
      { type: "ai-title", aiTitle: "Ship the release" },
    ],
    '{"type":"user","partial',
  );
  // A first prompt past the head window, a record over the decode limit and a malformed line.
  const big = join(project, `${id(1)}.jsonl`);
  await jsonl(
    big,
    [
      { type: "system", sessionId: id(1), cwd, subtype: "init" },
      ...Array.from({ length: 40 }, (_, i) => ({
        type: "progress",
        sessionId: id(1),
        cwd,
        n: i,
        pad: "p".repeat(4096),
      })),
      {
        type: "assistant",
        sessionId: id(1),
        cwd,
        message: { role: "assistant", content: "z".repeat(1_200_000) },
      },
      {
        type: "user",
        sessionId: id(1),
        cwd,
        timestamp: "2026-03-01T10:00:00.250Z",
        message: { role: "user", content: "The real question, after a long preamble" },
      },
      {
        type: "assistant",
        sessionId: id(1),
        cwd,
        message: { role: "assistant", content: [{ type: "text", text: "An answer" }] },
      },
    ],
    "not json at all\n" +
      JSON.stringify({
        type: "assistant",
        sessionId: id(1),
        cwd,
        message: { role: "assistant", content: "tail" },
      }) +
      "\n",
  );
  // Only provider bookkeeping: hidden from lists.
  await jsonl(join(project, `${id(2)}.jsonl`), [
    { type: "system", sessionId: id(2), cwd, subtype: "init" },
  ]);
  await jsonl(join(project, `${id(3)}.jsonl`), [
    { type: "user", sessionId: id(3), message: { role: "user", content: "no workspace" } },
  ]);
  const recorded = await recordedClaude(project);

  const codex = join(root, "codex");
  const sessions = join(codex, "sessions/2026/01/01");
  await jsonl(join(sessions, `rollout-${nativeId}.jsonl`), codexRecords());
  await jsonl(join(sessions, `rollout-fork.jsonl`), [
    { type: "session_meta", payload: { id: id(10), cwd, history_mode: "remote" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fork" }] },
    },
  ]);
  await jsonl(join(sessions, `rollout-child.jsonl`), [
    {
      type: "session_meta",
      payload: {
        id: id(11),
        cwd,
        source: { subagent: { thread_spawn: { parent_thread_id: nativeId } } },
      },
    },
    {
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking it over" }] },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "c1",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "c1", output: "Done" },
    },
    { type: "compacted", payload: { message: "compacted" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ]);
  await jsonl(join(sessions, "rollout-nometa.jsonl"), [
    { type: "response_item", payload: { type: "message", role: "user", content: [] } },
  ]);
  await writeFile(join(sessions, "rollout-compressed.jsonl.zst"), "zstd");
  await jsonl(join(codex, "archived_sessions", `rollout-${id(12)}.jsonl`), [
    { type: "session_meta", payload: { id: id(12), cwd: "/elsewhere" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "archived" }],
      },
    },
  ]);
  await jsonl(join(codex, "session_index.jsonl"), [
    { id: nativeId, thread_name: "Codex named this" },
    { id: id(11), thread_name: "Untitled" },
  ]);
  const db = new DatabaseSync(join(codex, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, updated_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?,?,?,?)").run(
    id(20),
    cwd,
    "Database-only thread",
    1767225600,
  );
  db.prepare("INSERT INTO threads VALUES (?,?,?,?)").run(
    nativeId,
    cwd,
    "Rollout and database",
    1767225700,
  );
  db.close();

  const cursor = join(root, "cursor");
  await mkdir(cursor, { recursive: true });
  // A sparse transcript, large on disk without being written.
  const sparse = await open(join(project, `${id(4)}.jsonl`), "w");
  await sparse.write(
    JSON.stringify({
      type: "user",
      sessionId: id(4),
      cwd,
      message: { role: "user", content: "huge" },
    }) + "\n",
  );
  await sparse.write('{"type":"assistant","pad":"', 0, "utf8");
  await sparse.write('"}\n', 50 * 1024 * 1024, "utf8");
  await sparse.close();
  return {
    recorded,
    instances: [
      { id: "claude-home", provider: "claude" as const, homeDir: claude },
      { id: "codex-home", provider: "codex" as const, homeDir: codex },
      { id: "cursor-home", provider: "cursor" as const, homeDir: cursor },
      ...(await providerHomes(root)),
    ],
  };
}
