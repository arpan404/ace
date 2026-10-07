import type { Fact } from "@ace/core";
import type { Scenario, Step } from "../scenario.ts";
import { endTurn, message, output, rootAgent, subagent, tool, toolDone, turn } from "./facts.ts";
import { checkout } from "./checkouts.ts";

/*
 * The approved design's hero thread, "Dedupe thread events after reconnect", as it looks a few
 * minutes into the work: a phone-sent ask, 4m 12s of tool work collapsed to one line, a
 * multi-paragraph answer, two changed files, "Started 2 subagents", a relay running in the
 * background with Stop, and a later finding from reconnect-audit while the root waits on both
 * subagents. Every step is backdated, so ages and durations read as real time.
 * Labels: `asked`, `worked`, `answered`, `delegated`, `background`, `finding`.
 */

const s = 1000;
const m = 60 * s;

const cursorDiff = `@@ -38,9 +38,14 @@ export function replayFrom(thread: Thread, cursor: ReplayCursor) {
-  const start = thread.lastCheckpointSeq;
+  // Replay after the last event the client acknowledged, not after the last checkpoint.
+  // seq 0 means the client has nothing cached: a bounded cold-start replay.
+  const start =
+    cursor.lastAckedSeq === 0
+      ? Math.max(0, thread.headSeq - COLD_START_WINDOW)
+      : cursor.lastAckedSeq;
   const events = thread.events.filter((e) => e.seq > start);
-  return { events, resumeToken: thread.checkpoint };
+  return { events, resumeToken: thread.headSeq, coldStart: cursor.lastAckedSeq === 0 };
 }
@@ -96,12 +101,19 @@ export class ReplaySession {
   onResume(client: Client, cursor: ReplayCursor) {
-    client.send({ type: "resume.ack", headSeq: this.thread.headSeq });
-    for (const e of this.thread.events) client.send(e);
+    const { events, coldStart } = replayFrom(this.thread, cursor);
+    client.send({ type: "resume.ack", headSeq: this.thread.headSeq, coldStart });
+    for (const e of events) {
+      if (this.sent.has(e.id)) continue;
+      this.sent.add(e.id);
+      client.send(e);
+    }
+    this.metrics.replayed.observe(events.length);
   }

   onClose() {
-    this.thread.unsubscribe(this);
+    this.thread.unsubscribe(this);
+    this.sent.clear();
   }`;

const outboxDiff = `@@ -18,11 +18,24 @@ export class Outbox {
   async resume(socket: RelaySocket) {
-    this.buffer.length = 0;
+    // Keep the buffer until the daemon confirms the resume, then flush it in order.
     socket.send({ type: "resume", lastAckedSeq: this.lastAckedSeq });
+    const ack = await socket.waitFor("resume.ack", { timeoutMs: 5_000 });
+    if (ack.coldStart) this.store.resetWindow(ack.headSeq);
+    this.flush(socket, ack.headSeq);
   }
+
+  private flush(socket: RelaySocket, headSeq: number) {
+    const pending = this.buffer.filter((frame) => frame.seq > headSeq);
+    this.buffer.length = 0;
+    for (const frame of pending) socket.send(frame);
+  }

   onEvent(event: ThreadEvent) {
-    this.store.apply(event);
+    // A replayed event the store already holds is acknowledged and dropped.
+    if (this.store.has(event.id)) return this.ack(event.seq);
+    this.store.apply(event);
     this.lastAckedSeq = event.seq;
   }`;

const answer = `The replay cursor resets on every \`resume\`, so the daemon resends everything after the last checkpoint instead of after the last event the client acknowledged. Two changes:

- **Server:** replay from \`lastAckedSeq\`, and treat \`seq: 0\` as a cold start that gets a bounded full replay.
- **Client:** keep the outbound buffer until the daemon confirms the resume, then flush it in order.

The regression test restarts the daemon mid-stream and asserts that no duplicate event id reaches the store. I've asked two subagents to audit the other reconnect paths and to write that test, and left the relay running so you can try a restart yourself.`;

const finding =
  "**reconnect-audit** found one more path: the mobile client resumes with `seq: 0` when its cache is empty, which the new cursor logic would read as a request for every event since the thread began. I'm capping cold-start replay at the last 200 events and letting the client backfill the rest on demand.";

/** One finished step of tool work, `agoMs` before now and taking `tookMs`. */
function work(agoMs: number, tookMs: number, start: Fact, end: Fact[] = []): Step[] {
  return [
    { kind: "facts", agoMs, facts: [start] },
    { kind: "facts", agoMs: agoMs - tookMs, facts: end },
  ];
}

function read(agoMs: number, key: string, path: string): Step[] {
  return work(
    agoMs,
    2 * s,
    tool("root", key, {
      kind: "file.read",
      title: `Read ${path}`,
      detail: { kind: "file.read", path },
    }),
    [toolDone("root", key)],
  );
}

function shell(agoMs: number, tookMs: number, key: string, command: string, out: string): Step[] {
  return work(
    agoMs,
    tookMs,
    tool("root", key, { kind: "shell", title: command, detail: { kind: "shell", command } }),
    [
      output("root", key, out),
      {
        type: "item.upsert",
        agent: "root",
        item: key,
        draft: {
          type: "tool_call",
          complete: true,
          call: { status: "succeeded", detail: { kind: "shell", exitCode: 0 } },
        },
      },
    ],
  );
}

function edit(agoMs: number, key: string, path: string, diff: string): Step[] {
  return work(
    agoMs,
    4 * s,
    tool("root", key, {
      kind: "file.edit",
      title: `Edit ${path}`,
      detail: { kind: "file.edit", changes: [{ path, kind: "update", diff }] },
    }),
    [toolDone("root", key)],
  );
}

export function dedupeReconnect(id = "thread-dedupe"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "ace",
      title: "Dedupe thread events after reconnect",
      provider: "claude",
      details: checkout({
        workspaceId: "ace",
        branch: "fix/replay-dedupe",
        path: "/Users/dev/.ace-next/worktrees/ace-replay-dedupe",
        head: "e07b3d",
        ahead: 2,
        pr: { number: 214, state: "open" },
      }),
    },
    steps: [
      {
        kind: "facts",
        label: "asked",
        agoMs: 11 * m,
        facts: [
          rootAgent("claude", "/Users/dev/ace"),
          turn("root"),
          // Sent from the phone with the client's outbox and the repo README attached.
          {
            type: "item.upsert",
            agent: "root",
            item: "ask",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [
                {
                  type: "text",
                  text: "After a daemon restart the web client shows the last 40 or so events twice. Repro: start a thread, kill the daemon, restart it, reconnect. Fix it with a regression test, and use subagents to audit the other reconnect paths.",
                },
                { type: "file", path: "apps/web/src/relay/outbox.ts", mimeType: "text/typescript" },
                { type: "file", path: "README.md", mimeType: "text/markdown" },
              ],
            },
          },
        ],
      },
      {
        kind: "facts",
        agoMs: 10 * m + 55 * s,
        facts: [
          {
            type: "item.upsert",
            agent: "root",
            item: "think",
            draft: {
              type: "reasoning",
              complete: true,
              text: "Duplicates right after a restart point at the resume path: either the cursor the client sends is stale, or the daemon ignores it. Read the replay code first.",
            },
          },
        ],
      },
      ...read(10 * m + 50 * s, "read-replay", "apps/daemon/src/replay.ts"),
      ...read(10 * m + 44 * s, "read-cursor", "apps/daemon/src/cursor.ts"),
      ...read(10 * m + 38 * s, "read-session", "apps/daemon/src/replay-session.ts"),
      ...work(
        10 * m + 30 * s,
        3 * s,
        tool("root", "search-acked", {
          kind: "search",
          title: "Search lastAckedSeq",
          detail: { kind: "search", query: "lastAckedSeq", path: "apps", matches: 7 },
        }),
        [toolDone("root", "search-acked")],
      ),
      ...read(10 * m + 20 * s, "read-outbox", "apps/web/src/relay/outbox.ts"),
      ...read(10 * m + 12 * s, "read-store", "packages/client/src/store.ts"),
      ...read(10 * m + 4 * s, "read-resume", "apps/mobile/src/resume.ts"),
      ...shell(
        9 * m + 40 * s,
        48 * s,
        "repro",
        "bun run test:e2e reconnect --repeat 5",
        "✗ reconnect › restart mid-stream (5/5 failed)\n  expected 1206 unique ids, got 1246 (40 duplicates)\n",
      ),
      ...edit(8 * m + 10 * s, "edit-replay", "apps/daemon/src/replay-session.ts", cursorDiff),
      ...edit(7 * m + 20 * s, "edit-outbox", "apps/web/src/relay/outbox.ts", outboxDiff),
      ...shell(
        7 * m,
        34 * s,
        "test-daemon",
        "bun run test apps/daemon",
        "✓ replay.spec.ts (11 tests)\n✓ cursor.spec.ts (4 tests)\n✓ resume.spec.ts (5 tests)\n\nTest Files  3 passed (3)\n     Tests  20 passed (20)\n",
      ),
      // The last step starts 4m 12s after the reasoning began (the work log spans step starts).
      ...shell(6 * m + 43 * s, 8 * s, "typecheck", "bun run typecheck", "tsc -b\n"),
      {
        kind: "facts",
        label: "worked",
        agoMs: 6 * m + 42 * s,
        facts: [],
      },
      {
        kind: "facts",
        label: "answered",
        agoMs: 6 * m + 40 * s,
        facts: [message("root", "answer", "assistant", answer)],
      },
      {
        kind: "facts",
        label: "delegated",
        agoMs: 6 * m + 30 * s,
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
        ],
      },
      {
        kind: "facts",
        label: "background",
        agoMs: 6 * m + 10 * s,
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
            "relay listening on ws://127.0.0.1:8787\nclient web-1 connected · resume seq 1182 · replay 0 events\n",
          ),
        ],
      },
      {
        kind: "facts",
        agoMs: 3 * m,
        facts: [
          {
            type: "activity",
            agent: "test",
            activity: "tool",
            detail: "bun run test replay --watch",
          },
          output("root", "relay", "client ios-2 connected · resume seq 0 · cold start\n"),
        ],
      },
      {
        kind: "facts",
        label: "finding",
        agoMs: 1 * m + 30 * s,
        facts: [
          // reconnect-audit reports its finding and stops; the root relays it.
          endTurn("audit"),
          message("root", "finding", "assistant", finding),
          { type: "subagents.waiting", agent: "root", item: "spawn-test", targets: [] },
        ],
      },
      {
        kind: "facts",
        label: "follow-up",
        agoMs: 35 * s,
        facts: [
          // The root sends it back to check the mobile cache path, so the thread moved just now.
          {
            type: "turn.started",
            agent: "audit",
            nativeTurnId: "audit-turn-2",
            trigger: "parent_agent",
          },
          {
            type: "activity",
            agent: "audit",
            activity: "tool",
            detail: "Reading apps/mobile/src/cache.ts",
          },
        ],
      },
    ],
  };
}
