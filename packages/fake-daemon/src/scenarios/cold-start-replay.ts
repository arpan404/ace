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
const activity = (agent: string, detail: string): Fact => ({
  type: "activity",
  agent,
  activity: "tool",
  detail,
});

/**
 * The thread the right and bottom panels are designed around: two turns of edits (one with
 * full file text, one as a provider unified diff), two subagents, a background dev server
 * with live output, and a slow settle. The first turn happened minutes earlier. Labels:
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
        label: "turn-1",
        agoMs: 9 * 60_000,
        facts: [
          rootAgent("claude", "/Users/dev/ace"),
          turn("root", "t1"),
          message(
            "root",
            "ask-1",
            "user",
            "A phone that resumes with seq 0 gets every event since the thread began. Cap cold-start replay.",
          ),
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
          toolDone("root", "edit-replay-1"),
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
        delayMs: 1500,
        label: "turn-2",
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
          toolDone("root", "edit-replay-2"),
          tool("root", "spawn-audit", {
            kind: "agent.spawn",
            title: "Audit every resume path",
            detail: { kind: "agent.spawn", description: "Audit resume paths", childAgent: "audit" },
          }),
          subagent("claude", "audit", "reconnect-audit", "spawn-audit"),
          turn("audit", "audit-1", "spawn"),
          tool("audit", "edit-outbox", {
            kind: "file.edit",
            title: `Edit ${outboxDiff.path}`,
            detail: {
              kind: "file.edit",
              changes: [{ path: outboxDiff.path, kind: "update", diff: outboxDiff.diff }],
            },
          }),
          toolDone("audit", "edit-outbox"),
          activity("audit", "Reading apps/mobile/src/resume.ts"),
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
          turn("test", "test-1", "spawn"),
          tool("test", "run-tests", {
            kind: "shell",
            title: "Run the replay tests",
            detail: { kind: "shell", command: "bun run test replay" },
          }),
          activity("test", "bun run test replay"),
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
          output("root", "relay", "$ bun run dev:relay\nrelay listening on ws://127.0.0.1:8787\n"),
          { type: "subagents.waiting", agent: "root", item: "spawn-test", targets: [] },
        ],
      },
      {
        kind: "facts",
        delayMs: 2500,
        label: "relay-output",
        facts: [
          output(
            "root",
            "relay",
            "client web-1 connected · resume seq 1182\nreplay 0 events (lastAckedSeq 1182 == head)\nclient ios-2 connected · resume seq 0 · cold start\nreplay 200 events (capped), backfill offered\n",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 6000,
        label: "audit-done",
        facts: [
          message(
            "audit",
            "audit-report",
            "assistant",
            "The mobile client also resumes with seq 0 when its cache is empty; the cap covers it.",
          ),
          endTurn("audit", "audit-1"),
          toolDone("root", "spawn-audit"),
        ],
      },
      {
        kind: "facts",
        delayMs: 4000,
        label: "test-done",
        facts: [
          output("test", "run-tests", "3 pass · 0 fail · 1 file  412ms\n"),
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
        delayMs: 1500,
        label: "root-replied",
        facts: [
          message(
            "root",
            "reply-2",
            "assistant",
            "Both resume paths are covered and the regression test passes. The relay is still running for you to try.",
          ),
          endTurn("root", "t2"),
        ],
      },
    ],
  };
}
