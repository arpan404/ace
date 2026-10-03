import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { message, output, rootAgent, subagent, tool, toolDone } from "./facts.ts";
import { outboxDiff, replayTs } from "./replay-sources.ts";

const turn = (agent: string, id: string, trigger: "user" | "spawn" = "user"): Fact => ({
  type: "turn.started",
  agent,
  nativeTurnId: id,
  trigger,
});
const endTurn = (agent: string, id: string): Fact => ({
  type: "turn.ended",
  agent,
  nativeTurnId: id,
  outcome: "completed",
});
const s = 1000;
const m = 60 * s;
const activity = (agent: string, detail: string): Fact => ({
  type: "activity",
  agent,
  activity: "tool",
  detail,
});

/**
 * The thread the right and bottom panels are designed around: two turns of edits (one with
 * full file text, one as a provider unified diff), two subagents, a background dev server
 * with live output, and a slow settle. Both turns happened minutes before the page opened; the
 * subagents report back live (`autoplay`), tens of seconds apart. Labels:
 * `turn-1`, `turn-2`, `relay-output`, `audit-done`, `test-done`, `root-replied`.
 */
export function coldStartReplay(id = "thread-cold-start"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "ace",
      title: "Cap cold-start replay at 200 events",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 24 * m,
        facts: [
          rootAgent("claude", "/Users/dev/ace"),
          turn("root", "t1"),
          message(
            "root",
            "ask-1",
            "user",
            "A phone that resumes with seq 0 gets every event since the thread began. Cap cold-start replay.",
          ),
        ],
      },
      {
        kind: "facts",
        agoMs: 23 * m + 50 * s,
        facts: [
          tool("root", "read-replay-1", {
            kind: "file.read",
            title: `Read ${replayTs.path}`,
            detail: { kind: "file.read", path: replayTs.path },
          }),
          toolDone("root", "read-replay-1"),
        ],
      },
      {
        kind: "facts",
        agoMs: 22 * m + 40 * s,
        facts: [
          tool("root", "edit-replay-1", {
            kind: "file.edit",
            title: `Edit ${replayTs.path}`,
            detail: {
              kind: "file.edit",
              changes: [
                {
                  path: replayTs.path,
                  kind: "update",
                  oldText: replayTs.original,
                  newText: replayTs.afterTurn1,
                },
              ],
            },
          }),
        ],
      },
      { kind: "facts", agoMs: 22 * m + 25 * s, facts: [toolDone("root", "edit-replay-1")] },
      {
        kind: "facts",
        label: "turn-1",
        agoMs: 22 * m + 10 * s,
        facts: [
          message(
            "root",
            "reply-1",
            "assistant",
            "replayFrom now treats seq 0 as a cold start and replays at most the last 200 events.",
          ),
          endTurn("root", "t1"),
        ],
      },
      {
        kind: "facts",
        agoMs: 9 * m,
        facts: [
          turn("root", "t2"),
          message(
            "root",
            "ask-2",
            "user",
            "Send coldStart with the ack, keep the client buffer until it arrives, and add a regression test.",
          ),
          tool("root", "edit-replay-2", {
            kind: "file.edit",
            title: `Edit ${replayTs.path}`,
            detail: {
              kind: "file.edit",
              changes: [
                {
                  path: replayTs.path,
                  kind: "update",
                  oldText: replayTs.afterTurn1,
                  newText: replayTs.afterTurn2,
                },
              ],
            },
          }),
        ],
      },
      { kind: "facts", agoMs: 7 * m + 40 * s, facts: [toolDone("root", "edit-replay-2")] },
      {
        // Both subagents start together, as one "Started 2 subagents".
        kind: "facts",
        agoMs: 7 * m + 20 * s,
        facts: [
          tool("root", "spawn-audit", {
            kind: "agent.spawn",
            title: "Find every caller that resumes from seq 0",
            detail: {
              kind: "agent.spawn",
              description: "Sweep the web and mobile resume callers",
              childAgent: "audit",
            },
          }),
          tool("root", "spawn-test", {
            kind: "agent.spawn",
            title: "Test the client buffer against a late ack",
            detail: {
              kind: "agent.spawn",
              description: "Hold resume.ack for 2s and assert the buffer survives",
              childAgent: "test",
            },
          }),
          subagent("claude", "audit", "resume-sweep", "spawn-audit"),
          turn("audit", "audit-1", "spawn"),
          subagent("claude", "test", "ack-buffer-test", "spawn-test"),
          turn("test", "test-1", "spawn"),
        ],
      },
      {
        kind: "facts",
        agoMs: 6 * m + 30 * s,
        facts: [
          tool("audit", "edit-outbox", {
            kind: "file.edit",
            title: `Edit ${outboxDiff.path}`,
            detail: {
              kind: "file.edit",
              changes: [{ path: outboxDiff.path, kind: "update", diff: outboxDiff.diff }],
            },
          }),
        ],
      },
      {
        kind: "facts",
        agoMs: 5 * m + 50 * s,
        facts: [
          toolDone("audit", "edit-outbox"),
          // resume-sweep checks pairing in the browser; the Preview tab names it as the driver.
          tool("audit", "browse-pairing", {
            kind: "browser",
            title: "Pair a phone on localhost:5173/settings/devices",
            detail: { kind: "browser" },
          }),
          activity("audit", "Reading apps/mobile/src/resume.ts"),
          tool("test", "run-tests", {
            kind: "shell",
            title: "Run the outbox tests",
            detail: { kind: "shell", command: "bun run test outbox" },
          }),
          activity("test", "bun run test outbox"),
        ],
      },
      {
        kind: "facts",
        label: "turn-2",
        agoMs: 5 * m + 20 * s,
        facts: [
          tool("root", "relay", {
            kind: "shell",
            title: "Soak the relay with two clients",
            detail: { kind: "shell", command: "bun run relay:soak --clients 2" },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "relay",
            kind: "shell",
            title: "bun run relay:soak --clients 2",
            item: "relay",
            stoppable: true,
          },
          output(
            "root",
            "relay",
            "$ bun run relay:soak --clients 2\nsoak relay listening on ws://127.0.0.1:8790\n",
          ),
          { type: "subagents.waiting", agent: "root", item: "spawn-test", targets: [] },
        ],
      },
      {
        kind: "facts",
        agoMs: 3 * m + 5 * s,
        label: "relay-output",
        facts: [
          {
            type: "item.upsert",
            agent: "root",
            item: "quota-warning",
            draft: {
              type: "notice",
              complete: true,
              level: "warning",
              text: "Claude Code · personal has used 82% of its 5-hour window; new turns may wait for the reset.",
            },
          },
          output(
            "root",
            "relay",
            "client web-1 connected · resume seq 1182\nreplay 0 events (lastAckedSeq 1182 == head)\nclient ios-2 connected · resume seq 0 · cold start\nreplay 200 events (capped), backfill offered\n",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 45_000,
        label: "audit-done",
        facts: [
          message(
            "audit",
            "audit-report",
            "assistant",
            "Three callers resume from seq 0: the web tab after a cache wipe, the iOS cold launch and the share extension. The cap covers all three.",
          ),
          toolDone("audit", "browse-pairing"),
          endTurn("audit", "audit-1"),
          toolDone("root", "spawn-audit"),
        ],
      },
      {
        kind: "facts",
        delayMs: 20_000,
        label: "test-done",
        facts: [
          output("test", "run-tests", "5 pass · 0 fail · 2 files  1.38s\n"),
          toolDone("test", "run-tests"),
          endTurn("test", "test-1"),
          toolDone("root", "spawn-test"),
          output(
            "root",
            "relay",
            "client web-1 reconnected · resume seq 1206 · replay 3 events\n0 duplicates in store\n",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 6_000,
        label: "root-replied",
        facts: [
          message(
            "root",
            "reply-2",
            "assistant",
            "All three seq-0 callers are capped and the late-ack test passes. The soak relay is still running if you want to poke at it.",
          ),
          endTurn("root", "t2"),
        ],
      },
    ],
  };
}
