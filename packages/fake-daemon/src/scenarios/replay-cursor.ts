import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { message, output, rootAgent, subagent, tool, toolDone, turn } from "./facts.ts";

const replayDiff = `@@ -38,9 +38,12 @@ export function replayFrom(thread: Thread, cursor: ReplayCursor) {
-  const start = thread.lastCheckpointSeq;
+  // seq 0 means the client has nothing cached: bounded cold-start replay.
+  const start = cursor.lastAckedSeq === 0
+    ? Math.max(0, thread.headSeq - COLD_START_WINDOW)
+    : cursor.lastAckedSeq;
   const events = thread.events.filter((e) => e.seq > start);
-  return { events, resumeToken: thread.checkpoint };
+  return { events, resumeToken: thread.headSeq, coldStart: cursor.lastAckedSeq === 0 };
 }
@@ -105,6 +108,7 @@ onResume(client: Client, cursor: ReplayCursor) {
+    const { events, coldStart } = replayFrom(this.thread, cursor);
     client.send({ type: "resume.ack", headSeq: this.thread.headSeq });
-    for (const e of this.thread.events) client.send(e);
+    for (const e of events) client.send(e);
   }`;

const outboxDiff = `@@ -18,7 +18,9 @@ export class Outbox {
   async resume(socket: RelaySocket) {
-    this.buffer.length = 0;
+    // keep the buffer until the daemon confirms the resume, then flush in order
     socket.send({ type: "resume", lastAckedSeq: this.lastAckedSeq });
+    const ack = await socket.waitFor("resume.ack");
+    this.flush(socket, ack.headSeq);
   }`;

const answer = `The replay cursor resets on every \`resume\`, so the daemon resends everything after the last checkpoint instead of after the last event the client acknowledged. Two changes:

- **Server:** replay from \`lastAckedSeq\`, and treat \`seq: 0\` as a cold start that gets a bounded full replay.
- **Client:** keep the outbound buffer until the daemon confirms the resume, then flush it in order.

The regression test restarts the daemon mid-stream and asserts that no duplicate event id reaches the store:

\`\`\`ts
test("a daemon restart mid-stream delivers every event once", async () => {
  const relay = await startRelay();
  const client = connect(relay, { lastAckedSeq: 0 });
  await relay.restart();
  // 1206 events, each id seen exactly once
  expect(new Set(client.ids()).size).toBe(client.ids().length);
});
\`\`\``;

function read(key: string, path: string): Fact[] {
  return [
    tool("root", key, {
      kind: "file.read",
      title: `Read ${path}`,
      detail: { kind: "file.read", path },
    }),
    toolDone("root", key),
  ];
}

function shell(key: string, command: string, out: string, exitCode = 0): Fact[] {
  return [
    tool("root", key, { kind: "shell", title: command, detail: { kind: "shell", command } }),
    output("root", key, out),
    {
      type: "item.upsert",
      agent: "root",
      item: key,
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          status: exitCode === 0 ? "succeeded" : "failed",
          detail: { kind: "shell", exitCode },
        },
      },
    },
  ];
}

/**
 * The approved thread design end to end: a phone-sent ask, a collapsed work log (reads, a
 * search, commands, two edits), a markdown answer with a code block, two subagents, a
 * background relay and a later finding while the root waits on its subagents.
 * Labels: `asked`, `worked`, `answered`, `delegated`, `background`, `finding`.
 */
export function replayCursor(id = "thread-replay-cursor"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "relay",
      title: "Replay cursor resets on every resume",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        label: "asked",
        agoMs: 5 * 60_000,
        facts: [
          rootAgent("claude", "/Users/dev/relay"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "After a daemon restart the web client replays the last 40 or so events twice. Repro: start a thread, kill the daemon, restart it, reconnect. Fix it with a regression test, and use a subagent to audit the other reconnect paths.",
          ),
        ],
      },
      {
        // Reading and searching start a few seconds after the ask; editing and tests follow
        // minutes later, so the work log reads as real time.
        kind: "facts",
        delayMs: 300,
        agoMs: 4 * 60_000 + 50_000,
        facts: [
          {
            type: "item.upsert",
            agent: "root",
            item: "think",
            draft: {
              type: "reasoning",
              complete: true,
              text: "Duplicates after a restart point at the resume path. Check where the replay cursor comes from and whether the client clears its buffer before the ack.",
            },
          },
          ...read("read-replay", "apps/server/src/replay.ts"),
          ...read("read-outbox", "apps/web/src/relay/outbox.ts"),
          ...read("read-cursor", "apps/server/src/cursor.ts"),
          tool("root", "search-acked", {
            kind: "search",
            title: "Search lastAckedSeq",
            detail: { kind: "search", query: "lastAckedSeq", path: "apps", matches: 4 },
          }),
          toolDone("root", "search-acked"),
        ],
      },
      {
        kind: "facts",
        delayMs: 300,
        label: "worked",
        agoMs: 2 * 60_000 + 20_000,
        facts: [
          ...shell(
            "test-server",
            "bun run test apps/server",
            "✓ replay.spec.ts (9 tests)\n✓ cursor.spec.ts (4 tests)\n✓ resume.spec.ts (3 tests)\n\nTest Files  3 passed (3)\n     Tests  16 passed (16)\n",
          ),
          tool("root", "edit-replay", {
            kind: "file.edit",
            title: "Edit apps/server/src/replay.ts",
            detail: {
              kind: "file.edit",
              changes: [{ path: "apps/server/src/replay.ts", kind: "update", diff: replayDiff }],
            },
          }),
          toolDone("root", "edit-replay"),
          tool("root", "edit-outbox", {
            kind: "file.edit",
            title: "Edit apps/web/src/relay/outbox.ts",
            detail: {
              kind: "file.edit",
              changes: [{ path: "apps/web/src/relay/outbox.ts", kind: "update", diff: outboxDiff }],
            },
          }),
          toolDone("root", "edit-outbox"),
          ...shell("typecheck", "bun run typecheck", "$ tsc -b\n"),
        ],
      },
      {
        kind: "facts",
        delayMs: 600,
        label: "answered",
        agoMs: 2 * 60_000,
        facts: [message("root", "answer", "assistant", answer)],
      },
      {
        kind: "facts",
        delayMs: 600,
        label: "delegated",
        agoMs: 110_000,
        facts: [
          tool("root", "spawn-audit", {
            kind: "agent.spawn",
            title: "Audit every resume path",
            detail: {
              kind: "agent.spawn",
              description: "Audit the other reconnect paths for cursor resets",
              childAgent: "audit",
            },
          }),
          subagent("claude", "audit", "reconnect-audit", "spawn-audit"),
          turn("audit", "spawn"),
          {
            type: "activity",
            agent: "audit",
            activity: "tool",
            detail: "Reading apps/mobile/src/resume.ts",
          },
          tool("root", "spawn-test", {
            kind: "agent.spawn",
            title: "Write the regression test",
            detail: {
              kind: "agent.spawn",
              description: "Restart the daemon mid-stream and assert no duplicates",
              childAgent: "test",
            },
          }),
          subagent("claude", "test", "regression-test", "spawn-test"),
          turn("test", "spawn"),
          { type: "activity", agent: "test", activity: "tool", detail: "bun run test replay" },
        ],
      },
      {
        kind: "facts",
        delayMs: 600,
        label: "background",
        agoMs: 100_000,
        facts: [
          tool("root", "relay", {
            kind: "shell",
            title: "Run the relay in the background",
            detail: { kind: "shell", command: "bun run dev:relay" },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "relay",
            kind: "shell",
            title: "bun run dev:relay",
            item: "relay",
            stoppable: true,
          },
          output(
            "root",
            "relay",
            "relay listening on ws://127.0.0.1:8787\nclient web-1 connected · resume seq 1182\n",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 1500,
        label: "finding",
        agoMs: 40_000,
        facts: [
          message(
            "root",
            "finding",
            "assistant",
            "**reconnect-audit** found one more path: the mobile client resumes with `seq: 0` when its cache is empty, which the new cursor logic would read as a request for every event since the thread began. I'm capping cold-start replay at the last 200 events and letting the client backfill the rest on demand.",
          ),
          { type: "subagents.waiting", agent: "root", item: "spawn-test", targets: [] },
        ],
      },
    ],
  };
}
