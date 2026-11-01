import type { Fact } from "@ace/core";
import type { Scenario, Step } from "../scenario.ts";
import {
  endTurn,
  finish,
  message,
  rootAgent,
  stream,
  subagent,
  tool,
  toolDone,
  turn,
} from "./facts.ts";

const cwd = "/Users/dev/relay";

/** The reply streamed under the subagent row: inline code, a list, links and a code fence. */
export const streamingReplyText = `Starting the dedicated thread now. I'm also adding one bug the web-test cleanup just found: \`rm -Rf\` with an empty \`$TMPDIR\` would delete from the root, so the cleanup now refuses to run without it.

What changed:

- \`scripts/clean.ts\` checks \`process.env.TMPDIR\` before it deletes anything;
- the sweep skips paths outside \`/tmp/ace-*\`, see [the cleanup notes](https://example.com/cleanup);
- a test covers the empty case in \`clean.test.ts\`.

\`\`\`ts
export function cleanRoot(env: NodeJS.ProcessEnv): string {
  const root = env.TMPDIR?.trim();
  if (!root) throw new Error("TMPDIR is not set");
  return root;
}
\`\`\`

Next I'll run \`bun run test scripts/clean.test.ts\` and report back in [the thread](ace://thread/thread-streaming-reply).`;

/** Splits text into the small, uneven deltas a provider streams. */
export function streamChunks(
  text: string,
  sizes: readonly number[] = [7, 3, 11, 5, 9, 4],
): string[] {
  const chunks: string[] = [];
  for (let at = 0, index = 0; at < text.length; index++) {
    const size = sizes[index % sizes.length] ?? 8;
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

/**
 * A turn whose subagent already finished ("1 subagent ran") and whose answer then streams in
 * small chunks, for watching the transcript while a reply grows. `?fakeWorld=streaming-reply`
 * seeds it through `asked`; the page then plays the stream (`aceStreamReply.play()`), or steps it.
 */
export function streamingReply(
  options: { chunkDelayMs?: number; history?: number; afterStep?: boolean } = {},
): Scenario {
  const delayMs = options.chunkDelayMs ?? 40;
  // Earlier turns, so the transcript scrolls and its rows are virtualized as a real thread's are.
  const history: Fact[] = [];
  for (let n = 1; n <= (options.history ?? 0); n++)
    history.push(
      { type: "turn.started", agent: "root", nativeTurnId: `earlier-${n}`, trigger: "user" },
      message(
        "root",
        `earlier-ask-${n}`,
        "user",
        `Earlier question ${n}: what does step ${n} change?`,
      ),
      message("root", `earlier-answer-${n}`, "assistant", earlierAnswer(n)),
      { type: "turn.ended", agent: "root", nativeTurnId: `earlier-${n}`, outcome: "completed" },
    );
  const deltas: Step[] = streamChunks(streamingReplyText).map((append) => ({
    kind: "facts",
    delayMs,
    facts: [stream("root", "reply", append)],
  }));
  return {
    thread: {
      id: "thread-streaming-reply",
      workspaceId: "relay",
      title: "Clean up the web test temp dirs",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 60_000,
        facts: [
          rootAgent("claude", cwd),
          ...history,
          turn("root"),
          message("root", "ask", "user", "Start a dedicated thread for the web test cleanup."),
          message(
            "root",
            "plan",
            "assistant",
            "Clear: the new thread fixes only things outside the sidebar, in a new worktree branched from this one (`ace/sidebar-rail-integration`).",
          ),
          tool("root", "spawn-clean", {
            kind: "agent.spawn",
            title: "Audit the web test cleanup",
            detail: {
              kind: "agent.spawn",
              description: "Find what the web test cleanup deletes",
              childAgent: "clean",
            },
          }),
          subagent("claude", "clean", "cleanup-audit", "spawn-clean"),
          turn("clean", "spawn"),
        ],
      },
      {
        kind: "facts",
        label: "asked",
        agoMs: 5_000,
        facts: [
          endTurn("clean"),
          toolDone("root", "spawn-clean"),
          // A step after the subagent: the reply then streams inside the turn's work log.
          ...(options.afterStep
            ? [
                tool("root", "read-clean", {
                  kind: "file.read",
                  title: "Read scripts/clean.ts",
                  detail: { kind: "file.read", path: "scripts/clean.ts" },
                }),
                toolDone("root", "read-clean"),
              ]
            : []),
        ],
      },
      // Claude thinks before it answers: a reasoning item whose words stay hidden, which
      // completes the moment the answer starts.
      {
        kind: "facts",
        label: "thinking",
        delayMs,
        facts: [thought("think-1", false)],
      },
      {
        kind: "facts",
        label: "reply-started",
        delayMs: 600,
        facts: [
          thought("think-1", true),
          {
            type: "item.upsert",
            agent: "root",
            item: "reply",
            draft: { type: "message", role: "assistant", complete: false, parts: [] },
          },
        ],
      },
      ...deltas,
      { kind: "facts", label: "replied", delayMs, facts: [finish("root", "reply")] },
      // It thinks again, then starts the thread it promised.
      { kind: "facts", label: "thinking-again", delayMs: 150, facts: [thought("think-2", false)] },
      {
        kind: "facts",
        label: "starting",
        delayMs: 900,
        facts: [
          thought("think-2", true),
          tool("root", "start-thread", {
            kind: "shell",
            title: "Start the cleanup thread",
            detail: { kind: "shell", command: "ace thread start" },
          }),
        ],
      },
      { kind: "facts", label: "started", delayMs: 600, facts: [toolDone("root", "start-thread")] },
      { kind: "facts", label: "ended", delayMs: 400, facts: [endTurn("root")] },
    ],
  };
}

function earlierAnswer(n: number): string {
  return `Step ${n} moves \`cleanup-${n}\` behind the guard. It now:

- reads \`TMPDIR\` once;
- skips [paths outside the sandbox](https://example.com/step-${n}).

\`\`\`ts
export const step${n} = guard("cleanup-${n}");
\`\`\``;
}

/** A thought whose words the provider keeps hidden, as Claude's are. */
function thought(item: string, complete: boolean): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: { type: "reasoning", complete, text: "" },
  };
}
