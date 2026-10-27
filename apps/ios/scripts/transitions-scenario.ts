import type { Fact } from "@ace/core";
import { createHash } from "node:crypto";
import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";

/*
 * Threads for the message actions on the spike daemon: "ios-turns", three finished turns to fork,
 * edit, list and step between; "ios-pi", two Pi turns whose answers carry Pi's entries, so Retry
 * and Rewind show; and "ios-markdown", an answer with math, highlighted code and a diff fence.
 */

type Details = (branch: string) => Record<string, unknown>;

const answer = (item: string, text: string, nativeId?: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "message",
    role: "assistant",
    complete: true,
    ...(nativeId ? { nativeId } : {}),
    parts: [{ type: "text", text }],
  },
});

/** The picture the second ask of "ios-turns" carries, stored for the thread. */
const screenshot = {
  sha256: fixtureImage.sha256,
  bytes: Buffer.from(fixtureImage.data, "base64").length,
  mimeType: "image/png",
  name: "queue-timings.png",
  kind: "image" as const,
  width: 120,
  height: 80,
  thumbnailAvailable: true,
};
const notes = "Queue timings\nbefore: 14 s\nafter: 1.2 s\n";

/** One finished turn of its own: the person's ask (with any files), then the answer. */
function turn(
  index: number,
  ask: string,
  reply: string,
  nativeId?: string,
  attachments: (typeof screenshot)[] = [],
): Fact[] {
  return [
    { type: "turn.started", agent: "root", nativeTurnId: `turn-${index}`, trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: `ask-${index}`,
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: ask }],
        ...(attachments.length ? { attachments } : {}),
      },
    },
    answer(`answer-${index}`, reply, nativeId),
    { type: "turn.ended", agent: "root", nativeTurnId: `turn-${index}`, outcome: "completed" },
  ];
}

const markdown = [
  "The variance is $\\sigma^2 = \\frac{1}{n}\\sum_{i=1}^{n}(x_i - \\mu)^2$, so the spread doubles.",
  "",
  "$$",
  "E = mc^2 \\quad \\text{and} \\quad \\int_0^\\infty e^{-x}\\,dx = 1",
  "$$",
  "",
  "```ts",
  "export function retry<T>(run: () => Promise<T>, times = 3): Promise<T> {",
  "  // Each failure waits twice as long as the last.",
  "  return run().catch((error: unknown) => (times > 0 ? retry(run, times - 1) : Promise.reject(error)));",
  "}",
  "```",
  "",
  "```diff",
  "--- a/src/queue.ts",
  "+++ b/src/queue.ts",
  "@@ -1,4 +1,4 @@",
  " export const limit = {",
  "-  attempts: 3,",
  "+  attempts: 5,",
  "   backoffMs: 200,",
  " };",
  "```",
].join("\n");

export function seedTransitions(daemon: FakeDaemon, details: Details) {
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-turns",
    workspaceId: "ace",
    title: "Speed up the queue tests",
    provider: "codex",
    details: details("perf/queue-tests"),
  });
  daemon.apply("ios-turns", [
    facts.rootAgent("codex"),
    ...turn(1, "Why are the queue tests slow?", "Each test waits on a real 200 ms backoff."),
    ...turn(
      2,
      "Can we fake the clock instead?",
      "Yes. The queue takes its clock as an argument now.",
      undefined,
      [screenshot],
    ),
    ...turn(3, "Run the suite again", "The suite runs in 1.2 s, down from 14 s."),
  ]);
  daemon.seedServices({
    attachmentImages: [{ threadId: "ios-turns", name: screenshot.name }],
    attachmentTexts: [
      {
        threadId: "ios-turns",
        sha256: createHash("sha256").update(notes).digest("hex"),
        text: notes,
        name: "timings.txt",
      },
    ],
  });
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-pi",
    workspaceId: "ace",
    title: "Plan the cache change",
    provider: "pi",
    details: details("main"),
  });
  daemon.apply("ios-pi", [
    facts.rootAgent("pi"),
    ...turn(1, "Plan the change", "Here is the plan: cache reads for a minute.", "entry-1"),
    ...turn(2, "Use the other approach", "Switched to invalidating on write.", "entry-2"),
  ]);
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-markdown",
    workspaceId: "ace",
    title: "Explain the retry maths",
    provider: "codex",
    details: details("main"),
  });
  daemon.apply("ios-markdown", [
    facts.rootAgent("codex"),
    ...turn(1, "Explain the retry maths", markdown),
  ]);
}
